import { RuleBase, IRule } from "./rules-base";
import { CodeAction, CodeActionKind, Command, DiagnosticSeverity, TextEdit } from "vscode-languageserver";
import { IHasLexerToken, IHasPorts, implementsIHasPorts, implementsIHasGenerics, implementsIHasTypes, implementsIHasComponents, implementsIHasSignals, implementsIHasVariables, implementsIHasConstants, implementsIHasSubprograms } from "../parser/interfaces";
import { OFile, ObjectBase, OPackage, OPackageBody, OType, OEntity, OSubprogram, OComponent, ORead, OWrite, OSignal, OArchitecture, OProcess, OInstantiation } from "../parser/objects";

export class RUnused extends RuleBase implements IRule {
  public name = 'unused';
  file: OFile;
  private unusedSignalRegex: RegExp;

  private addUnusedMessage(obj: ObjectBase & IHasLexerToken, msg: string) {
    // ignore unused warnings in packages (they are globally visible)
    if (obj.parent instanceof OPackage || obj.parent instanceof OPackageBody) {
      return;
    }
    // ignore unused warnings in protected types (they are globally visible)
    if (obj.parent instanceof OType && (obj.parent.protected || obj.parent.protectedBody)) {
      return;
    }
    // ignore entities that do not have the architecture in the same file
    if (obj.parent instanceof OEntity && obj.rootFile.architectures.find(a => a.entityName?.getLText() === (obj.parent as OEntity).lexerToken.getLText()) === undefined) {
      return;
    }
    if (this.unusedSignalRegex.exec(obj.lexerToken.text) === null) {
      this.addMessage({
        range: obj.lexerToken.range,
        severity: DiagnosticSeverity.Warning,
        message: msg,
        code: this.vhdlLinter.addCodeActionCallback((textDocumentUri: string) =>
          this.unusedSignalRegex.exec(obj.lexerToken.text + '_unused') !== null ? [CodeAction.create(
            `Add '_unused' to the name.`,
            {
              changes: {
                [textDocumentUri]: [
                  TextEdit.insert(obj.lexerToken.range.end, `_unused`)]
              }
            },
            CodeActionKind.QuickFix)] : []
        )
      });
    }
  }

  private checkUnusedPorts(obj: ObjectBase & IHasPorts) {
    // ignore procedure/function declarations (without implementation)
    if (obj instanceof OSubprogram && obj.hasBody === false) {
      return;
    }
    // ignore component ports
    if (obj instanceof OComponent) {
      return;
    }
    for (const port of obj.ports) {
      const type = port.typeReference[0]?.definitions?.[0];
      // Ignore ports of protected types as they are assumed to have side-effects so will not be read/written
      if ((type instanceof OType && (type.protected || type.protectedBody))) {
        continue;
      }
      const references = port.referenceLinks.slice(0);
      references.push(...port.aliasReferences.flatMap(alias => alias.referenceLinks));
      if ((port.direction === 'in' || port.direction === 'inout') && references.filter(token => token instanceof ORead).length === 0) {

        this.addUnusedMessage(port, `Not reading input port '${port.lexerToken}'`);
      }
      const writes = references.filter(token => token instanceof OWrite);
      if ((port.direction === 'out' || port.direction === 'inout') && writes.length === 0) {
        this.addUnusedMessage(port, `Not writing output port '${port.lexerToken}'`);
      }
    }
  }
  private checkMultipleDriver(signal: OSignal) {
    const writes = signal.referenceLinks.filter(token => token instanceof OWrite);
    // check for multiple drivers
    const writeScopes = writes.map(write => {
      // checked scopes are: OArchitecture, OProcess, OInstantiation (only component and entity)
      let scope: ObjectBase | OFile = write.parent;
      while (!(scope instanceof OArchitecture
        || scope instanceof OFile
        || scope instanceof OProcess)) {
        if (scope instanceof OInstantiation && (scope.type === 'component' || scope.type === 'entity')) {
          break;
        }
        scope = scope.parent;
      }
      return { scope, write };
    });
    const filteredScopes = writeScopes.filter((v, i, a) => a.findIndex(x => x.scope === v.scope) === i);

    const ignoreAction = this.vhdlLinter.addCodeActionCallback((textDocumentUri: string) => {
      return [
        CodeAction.create(
          `Ignore multiple drivers of ${signal.lexerToken}`,
          Command.create(
            `Ignore multiple drivers of ${signal.lexerToken}`,
            'vhdl-linter:ignore-line',
            { textDocumentUri, range: signal.lexerToken.range }
          ),
          CodeActionKind.QuickFix
        )
      ];
    });
    if (filteredScopes.length > 1) {
      this.addMessage({
        code: ignoreAction,
        range: signal.lexerToken.range,
        severity: DiagnosticSeverity.Warning,
        message: `'${signal.lexerToken}' has multiple drivers (e.g. lines ${filteredScopes.map(s => `${s.write.range.start.line}`).join(', ')}).`
      });
      for (const write of writeScopes) {
        this.addMessage({
          code: ignoreAction,
          range: write.write.range,
          severity: DiagnosticSeverity.Warning,
          message: `Driver of multiple driven signal '${signal.lexerToken}'.`
        });
      }
    } else if (filteredScopes.length === 1 && writes.length > 1 && !(filteredScopes[0].scope instanceof OProcess)) {
      // if multiple writes in the architecture or one instantiation
      this.addMessage({
        code: ignoreAction,
        range: signal.lexerToken.range,
        severity: DiagnosticSeverity.Warning,
        message: `'${signal.lexerToken}' has ${writes.length} drivers (lines ${writeScopes.map(s => `${s.write.range.start.line}`).join(', ')}).`
      });
      for (const write of writeScopes) {
        this.addMessage({
          code: ignoreAction,
          range: write.write.range,
          severity: DiagnosticSeverity.Warning,
          message: `Driver of multiple driven signal '${signal.lexerToken}'.`
        });
      }
    }
  }
  async check() {
    const settings = (await this.vhdlLinter.settingsGetter(this.vhdlLinter.uri));
    this.unusedSignalRegex = new RegExp(settings.style.unusedSignalRegex);

    for (const obj of this.file.objectList) {
      if (implementsIHasPorts(obj)) {
        this.checkUnusedPorts(obj);
      }
      // ignore generics of components
      if (implementsIHasGenerics(obj) && !(obj instanceof OComponent)) {
        for (const generic of obj.generics) {
          if (generic.referenceLinks.filter(token => token instanceof ORead).length === 0) {
            this.addUnusedMessage(generic, `Not reading generic ${generic.lexerToken}`);
          }

        }
      }
      if (implementsIHasTypes(obj)) {
        for (const type of obj.types) {
          const references = type.referenceLinks.slice(0);
          references.push(...type.aliasReferences.flatMap(alias => alias.referenceLinks));
          if (references.length === 0) {
            this.addUnusedMessage(type, `Not using type ${type.lexerToken}`);
          }
        }
      }
      if (implementsIHasComponents(obj)) {
        for (const comp of obj.components) {
          if (comp.referenceLinks.length === 0) {
            this.addUnusedMessage(comp, `Not using component ${comp.lexerToken}`);
          }
        }
      }
      if (implementsIHasSignals(obj)) {
        for (const signal of obj.signals) {
          const references = signal.referenceLinks.slice(0);
          references.push(...signal.aliasReferences.flatMap(alias => alias.referenceLinks));
          if (references.filter(token => token instanceof ORead).length === 0) {
            this.addUnusedMessage(signal, `Not reading signal ${signal.lexerToken}`);
          }
          else if (settings.rules.warnMultipleDriver) {
            this.checkMultipleDriver(signal);
          }
          if(!signal.lexerToken.text.match(new RegExp("_sig$", 'i'))
          && (!signal.lexerToken.text.match(new RegExp("_adr$", 'i')))
          && (!signal.lexerToken.text.match(new RegExp("_address$", 'i')))
          && (!signal.lexerToken.text.match(new RegExp("_n$", 'i')))
          && (!signal.lexerToken.text.match(new RegExp("_rw$", 'i')))
          && (!signal.lexerToken.text.match(new RegExp("_div$", 'i')))
          && (!signal.lexerToken.text.match(new RegExp("_pn$", 'i')))
          ){
            this.addUnusedMessage(signal, `Check signal suffix of ${signal.lexerToken}\n
            address signal: (_addr, _address)\n
            asynchronous signal: (_a)\n
            active low signal: (_n)\n
            r/w signal: (_rw)\n
            division signal: (_div)\n
            local signal: _sig (bus_o <= bus_sig)\n
            pipelined signal: (_pn)\n
            `);
          } 
        }
      }
      if (implementsIHasVariables(obj)) {
        for (const variable of obj.variables) {
          const references = variable.referenceLinks.slice(0);
          references.push(...variable.aliasReferences.flatMap(alias => alias.referenceLinks));
          if (references.filter(token => token instanceof ORead).length === 0) {
            this.addUnusedMessage(variable, `Not reading variable ${variable.lexerToken}`);
          }
          if(!variable.lexerToken.text.match(new RegExp("_v$", 'i'))
          ){
            this.addUnusedMessage(variable, `Check variable suffix of ${variable.lexerToken}`);
          } 
          if (references.filter(token => token instanceof OWrite).length === 0) {
            // Assume protected type has side-effect and does not net writing to.
            const type = variable.typeReference[0]?.definitions?.[0];
            if ((type instanceof OType && (type.protected || type.protectedBody)) === false) {
              this.addUnusedMessage(variable, `Not writing variable '${variable.lexerToken}  
              (should be ${variable.lexerToken}_v)`);
            }
          }
        }
      }
      if (implementsIHasConstants(obj)) {
        for (const constant of obj.constants) {
          const references = constant.referenceLinks.slice(0);
          references.push(...constant.aliasReferences.flatMap(alias => alias.referenceLinks));
          if (references.filter(token => token instanceof ORead).length === 0) {
            this.addUnusedMessage(constant, `Not reading constant ${constant.lexerToken}`);
          }
          if(!constant.lexerToken.text.match(new RegExp("_const$", 'i'))
          ){
            this.addUnusedMessage(constant, `Check constant suffix of ${constant.lexerToken}
            (should be ${constant.lexerToken}_const)`);
          } 
    
        }
      }
      if (implementsIHasSubprograms(obj)) {
        for (const subprogram of obj.subprograms) {
          // Skip implicitly declared deallocate
          if (subprogram.lexerToken.getLText() === 'deallocate') {
            continue;
          }
          const references = subprogram.referenceLinks.slice(0);
          references.push(...subprogram.aliasReferences.flatMap(alias => alias.referenceLinks));
          if (references.length === 0) {
            this.addUnusedMessage(subprogram, `Not using subprogram ${subprogram.lexerToken}`);
          }

        }
      }
    }
  }
}