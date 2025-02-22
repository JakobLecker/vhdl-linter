import { OLexerToken } from '../lexer';
import { ExpressionParser } from './expression-parser';
import { IHasConstants, IHasFileVariables, IHasSignals, IHasVariables, implementsIHasConstants, implementsIHasFileVariables, implementsIHasSignals, implementsIHasVariables } from './interfaces';
import { ObjectBase, OConstant, OFileVariable, ORead, OSignal, OVariable, ParserError } from './objects';
import { ParserBase, ParserState } from './parser-base';

export class ObjectDeclarationParser extends ParserBase {

  constructor(state: ParserState, private parent: ObjectBase & (IHasSignals | IHasConstants | IHasVariables | IHasFileVariables)) {
    super(state);
    this.debug('start');
  }
  parse(nextToken: OLexerToken) {
    let shared = false;
    if (nextToken.getLText() === 'shared') {
      shared = true;
      this.consumeToken();
      nextToken = this.getToken();
    }
    const objects = [];
    const constant = nextToken.getLText() === 'constant';
    const variable = nextToken.getLText() === 'variable';
    const file = nextToken.getLText() === 'file';
    if ((variable) && !implementsIHasVariables(this.parent)) {
      throw new ParserError(`No variables allowed here.`, this.state.pos.getRangeToEndLine());
    }
    if ((file) && !implementsIHasFileVariables(this.parent)) {
      throw new ParserError(`No files allowed here.`, this.state.pos.getRangeToEndLine());
    }
    if (constant && !implementsIHasConstants(this.parent)) {
      throw new ParserError(`No constants allowed here.`, this.state.pos.getRangeToEndLine());
    }
    if (!variable && !constant && !file && !implementsIHasSignals(this.parent)) {
      throw new ParserError(`No signals allowed here`, this.state.pos.getRangeToEndLine());
    }
    this.consumeToken();
    do {
      this.maybe(',');
      let object;
      if (variable) {
        object = new OVariable(this.parent as IHasVariables, nextToken.range);
        object.shared = shared;
      } else if (constant) {
        object = new OConstant(this.parent as IHasConstants, nextToken.range);
      } else if (file) {
        object = new OFileVariable(this.parent as IHasFileVariables, nextToken.range);
      } else {
        object = new OSignal((this.parent as ObjectBase & IHasSignals), nextToken.range);
      }
      object.lexerToken = this.consumeToken();
      objects.push(object);

    } while (this.getToken().getLText() === ',');
    this.expect(':');
    if (file) {
      const typeToken = this.consumeToken();
      for (const file of objects as OFileVariable[]) {
        const typeRead = new ORead(file, typeToken);
        file.typeReference = [typeRead];
        if (this.maybe('open')) {
          const [tokens] = this.advanceParenthesisAware(['is', ';'], true, false);
          file.openKind = new ExpressionParser(this.state, file, tokens).parse();
        }
        if (this.maybe('is')) {
          const [tokens] = this.advanceParenthesisAware([';'], true, false);
          file.logicalName = new ExpressionParser(this.state, file, tokens).parse();
        }
        // TODO: Parse optional parts of file definition
        file.range = file.range.copyWithNewEnd(this.state.pos.i);
      }
    } else {
      // If multiple types have the same type reference (variable a,b : integer) only the last has the text.
      for (const signal of objects.slice(objects.length - 1)) {
        const { typeReads, defaultValueReads } = this.getType(signal, false);
        signal.typeReference = typeReads;
        signal.defaultValue = defaultValueReads;
        signal.range = signal.range.copyWithNewEnd(this.state.pos.i);
      }

    }
    for (const object of objects) {
      object.range.copyWithNewEnd(this.getToken().range.end);
    }
    this.advanceSemicolon();
    if (constant) {
      (this.parent as IHasConstants).constants.push(...objects as OSignal[]);
    } else if (variable) {
      (this.parent as IHasVariables).variables.push(...objects as OVariable[]);
    } else if (file) {
      (this.parent as IHasFileVariables).files.push(...objects as OFileVariable[]);
    } else {
      (this.parent as IHasSignals).signals.push(...objects as OSignal[]);
    }
  }
  getType(parent: ObjectBase, advanceSemicolon = true, endWithParenthesis = false) {
    let type;
    if (endWithParenthesis) {
      [type] = this.advanceParenthesisAware([';', 'is', ')'], true, false);
    } else {
      [type] = this.advanceParenthesisAware([';', 'is'], true, false);
    }
    let defaultValueReads;
    let typeReads;
    const index = type.findIndex(token => token.getLText() === ':=');
    if (index > -1) {
      const tokensDefaultValue = type.slice(index + 1);
      const typeTokens = type.slice(0, index);

      defaultValueReads = new ExpressionParser(this.state, parent, tokensDefaultValue).parse();
      typeReads = new ExpressionParser(this.state, parent, typeTokens).parse();
    } else {
      typeReads = new ExpressionParser(this.state, parent, type).parse();

    }
    if (advanceSemicolon) {
      this.expect(';');
      this.advanceWhitespace();
    }
    return {
      typeReads,
      defaultValueReads
    };
  }
}