import { ErrorCodes, Location, Position, ResponseError } from 'vscode-languageserver';
import { OLexerToken } from '../lexer';
import { IHasEndingLexerToken, implementsIHasEndingLexerToken, implementsIHasLexerToken, implementsIHasReference } from '../parser/interfaces';
import { OArchitecture, ObjectBase, OEntity, OGeneric, OInstantiation, OPackage, OPackageBody, OPort, OReference, OSubprogram, OUseClause } from '../parser/objects';
import { VhdlLinter } from '../vhdl-linter';
export async function getTokenFromPosition(linter: VhdlLinter, position: Position): Promise<OLexerToken | undefined> {

  const candidateTokens = linter.file.lexerTokens.filter(token => token.isDesignator())
    .filter(token => token.range.start.line === position.line
      && token.range.start.character <= position.character
      && token.range.end.character >= position.character);
  return candidateTokens[0];
}
export class SetAdd<T> extends Set<T> {
  add(... values: T[]) {
    for (const value of values) {
      super.add(value);
    }
    return this;
  }
}
export async function findReferenceAndDefinition(oldLinter: VhdlLinter, position: Position) {
  const linter = oldLinter.projectParser.cachedFiles.find(cachedFile => cachedFile.uri.toString() === oldLinter.file.uri.toString())?.linter;
  if (!linter) {
    throw new ResponseError(ErrorCodes.InvalidRequest, 'Error during find reference operation', 'Error during find reference operation');
  }
  const token = await getTokenFromPosition(linter, position);
  if (!token) {
    throw new ResponseError(ErrorCodes.InvalidRequest, 'Error during find reference operation', 'Error during find reference operation');
  }
  await linter.projectParser.elaborateAll(token.getLText());
  const definitions = new SetAdd<ObjectBase>();
  // find all possible definitions for the lexerToken
  for (const obj of linter.file.objectList) {
    if (obj instanceof OReference && obj.referenceToken === token) {
      if (obj.parent instanceof OUseClause) {
        definitions.add(...obj.parent.definitions);
      } else {
        definitions.add(...obj.definitions);

      }
    }
    if (obj instanceof OInstantiation) {
      if (obj.componentName === token) {
        definitions.add(...obj.definitions);

      }
    }
    if (implementsIHasLexerToken(obj) && obj.lexerToken === token) {
      definitions.add(obj);
    }
    if (implementsIHasEndingLexerToken(obj) && obj.endingLexerToken === token) {
      definitions.add(obj);
    }

    if (obj instanceof OArchitecture && obj.entityName === token) {
      if (obj.correspondingEntity) {
        definitions.add(obj.correspondingEntity);
      }
    }
  }
  // find all implementations/definitions of subprograms
  for (const definition of definitions) {
    if (definition instanceof OSubprogram) {
      definitions.add(...definition.parent.subprograms
        .filter(subprogram => subprogram.lexerToken.getLText() == definition.lexerToken?.getLText()));
      if (definition.parent instanceof OPackage) {
        definitions.add(...definition.parent.correspondingPackageBodies.flatMap(packageBodies => packageBodies.subprograms
          .filter(subprogram => subprogram.lexerToken.getLText() == definition.lexerToken?.getLText())));
      }
      if (definition.parent instanceof OPackageBody) {
        definitions.add(...((definition.parent as OPackageBody).correspondingPackage?.subprograms
          .filter(subprogram => subprogram.lexerToken.getLText() == definition.lexerToken?.getLText()) ?? []));
      }


    }
  }
  const definitionsList = [...definitions].map(definition => {
    if (definition instanceof OPackageBody && definition.correspondingPackage) {
      return definition.correspondingPackage;
    }
    return definition;

  });
  // find all tokens that are references to the definition
  const referenceTokens: OLexerToken[] = [];
  for (const definition of definitionsList) {
    if (implementsIHasReference(definition)) {
      if (definition.lexerToken) {
        referenceTokens.push(definition.lexerToken);
      }
      referenceTokens.push(...definition.referenceLinks.map(ref => ref.referenceToken).filter(token => token.getLText() === definition.lexerToken?.getLText()));
      if (definition instanceof OEntity) {
        referenceTokens.push(...definition.correspondingArchitectures.map(arch => arch.entityName));
        referenceTokens.push(...definition.referenceLinks.flatMap(link => link instanceof OInstantiation ? link.componentName : []));
      }
      if (definition instanceof OPort) {
        referenceTokens.push(...definition.parent.referenceLinks
          .flatMap(link => {
            if (link instanceof OInstantiation) {
              return link.portAssociationList?.children.flatMap(child => {
                return child.formalPart
                  .filter(formal => formal.referenceToken.getLText() === definition.lexerToken.getLText())
                  .map(formal => formal.referenceToken);
              }) ?? [];
            }
            return [];
          }));
      }
      if (definition instanceof OGeneric) {
        referenceTokens.push(...definition.parent.referenceLinks
          .flatMap(link => {
            if (link instanceof OInstantiation) {
              return link.genericAssociationList?.children.flatMap(child => {
                return child.formalPart
                  .filter(formal => formal.referenceToken.getLText() === definition.lexerToken.getLText())
                  .map(formal => formal.referenceToken);
              }) ?? [];
            }
            return [];
          }));
      }
      if (definition instanceof OPackage) {
        for (const correspondingPackageBody of definition.correspondingPackageBodies) {
          referenceTokens.push(correspondingPackageBody.lexerToken);
          if (correspondingPackageBody.endingLexerToken) {
            referenceTokens.push(correspondingPackageBody.endingLexerToken);
          }
        }
      }
    }
    if (implementsIHasEndingLexerToken(definition)) {
      referenceTokens.push((definition as IHasEndingLexerToken).endingLexerToken as OLexerToken);
    }

  }
  // make sure to only return one reference per range
  const map = new Map<string, OLexerToken>();
  for (const token of referenceTokens) {
    map.set(`${token.file.uri}-${token.range.start.i}-${token.range.end.i}`, token);
  }
  return [...map.values()];

}
export async function findReferencesHandler(linter: VhdlLinter, position: Position) {

  return (await findReferenceAndDefinition(linter, position))?.map(object => Location.create(object.file.uri.toString(), object.range));
}
