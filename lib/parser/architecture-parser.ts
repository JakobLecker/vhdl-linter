import { OLexerToken, TokenType } from '../lexer';
import { ConcurrentStatementParser, ConcurrentStatementTypes } from './concurrent-statement-parser';
import { DeclarativePartParser } from './declarative-part-parser';
import { OArchitecture, OBlock, OCaseGenerate, OConstant, OFile, OForGenerate, OI, OIfGenerate, OIfGenerateClause, ORead, OWhenGenerateClause, ParserError } from './objects';
import { ParserBase, ParserState } from './parser-base';

export class ArchitectureParser extends ParserBase {
  entityName: OLexerToken;
  constructor(state: ParserState, private parent: OArchitecture | OFile | OIfGenerate | OCaseGenerate, name?: OLexerToken) {
    super(state);
    this.debug('start');
    if (name) {
      this.entityName = name;
    }
  }
  public architecture: OArchitecture;
  parse(): OArchitecture;
  parse(skipStart: boolean, structureName: 'when-generate'): OWhenGenerateClause;
  parse(skipStart: boolean, structureName: 'generate'): OIfGenerateClause;
  parse(skipStart: boolean, structureName: 'block'): OBlock;
  parse(skipStart: boolean, structureName: 'generate', forConstant?: { constantName: OLexerToken, constantRange: ORead[], startPosI: number }): OForGenerate;
  parse(skipStart = false, structureName: 'architecture' | 'generate' | 'block' | 'when-generate' = 'architecture', forConstant?: { constantName: OLexerToken, constantRange: ORead[], startPosI: number }): OArchitecture | OForGenerate | OIfGenerateClause {
    this.debug(`parse`);
    if (structureName === 'architecture') {
      this.architecture = new OArchitecture(this.parent, this.getToken().range.copyExtendEndOfLine());
    } else if (structureName === 'block') {
      this.architecture = new OBlock(this.parent, this.getToken().range.copyExtendEndOfLine());
      // guarded block
      if (this.getToken().getLText() === '(') {
        const startRange = this.getToken().range;
        this.consumeToken(); // consume '('
        (this.architecture as OBlock).guardCondition = this.extractReads(this.architecture, this.advanceClosingParenthese());
        const guardRange = startRange.copyWithNewEnd(this.getToken().range.end);
        // implicit declare constant GUARD
        const constant = new OConstant(this.architecture, guardRange);
        constant.lexerToken = new OLexerToken('GUARD', guardRange, TokenType.basicIdentifier);
        // read GUARD constant to avoid 'not read' warning
        (this.architecture as OBlock).guardCondition?.push(new ORead(this.architecture, constant.lexerToken));
        this.architecture.constants.push(constant);
      }
      this.maybe('is');
    } else if (structureName === 'when-generate') {
      this.architecture = new OWhenGenerateClause(this.parent, this.getToken().range.copyExtendEndOfLine());
    } else if (!forConstant) {
      this.architecture = new OIfGenerateClause(this.parent, this.getToken().range.copyExtendEndOfLine());
    } else {
      if (this.parent instanceof OFile) {
        throw new ParserError(`For Generate can not be top level architecture!`, this.state.pos.getRangeToEndLine());
      }
      const { constantName, constantRange } = forConstant;
      this.architecture = new OForGenerate(this.parent as OArchitecture, this.getToken().range.copyExtendEndOfLine(), constantRange);
      const iterateConstant = new OConstant(this.architecture, constantName.range);
      iterateConstant.type = [];
      iterateConstant.lexerToken = constantName;
      this.architecture.constants.push(iterateConstant);
    }
    if (skipStart !== true) {
      this.architecture.lexerToken = this.consumeToken();
      this.expect('of');
      this.entityName = this.consumeToken();
      this.architecture.entityName = this.entityName;
      this.expect('is');
    }

    new DeclarativePartParser(this.state, this.architecture).parse(structureName !== 'architecture');
    this.architecture.endOfDeclarativePart = new OI(this.architecture, this.state.pos.i);
    this.maybe('begin');

    while (this.state.pos.isValid()) {
      this.advanceWhitespace();
      const nextToken = this.getToken();
      if (nextToken.getLText() === 'end') {
        if (structureName === 'when-generate') {
          break;
        }
        this.consumeToken();
        if (structureName === 'block') {
          this.expect(structureName);
        } else {
          this.maybe(structureName);
        }
        if (this.architecture.lexerToken) {
          this.maybe(this.architecture.lexerToken.text);
        }

        if (this.entityName) {
          this.maybe(this.entityName.text);
        }
        this.expect(';');
        break;
      }
      const statementParser = new ConcurrentStatementParser(this.state, this.architecture);
      if (statementParser.parse([
        ConcurrentStatementTypes.Assert,
        ConcurrentStatementTypes.Assignment,
        ConcurrentStatementTypes.Generate,
        ConcurrentStatementTypes.Block,
        ConcurrentStatementTypes.ProcedureInstantiation,
        ConcurrentStatementTypes.Process
      ], this.architecture, structureName === 'when-generate')) {
        break;
      }
    }
    this.debug('finished parse');
    return this.architecture;
  }


}
