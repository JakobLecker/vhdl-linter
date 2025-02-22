import { ErrorCodes, Position, ResponseError, TextEdit } from 'vscode-languageserver';
import { VhdlLinter } from "../vhdl-linter";
import { findReferenceAndDefinition, getTokenFromPosition } from "./findReferencesHandler";

export async function prepareRenameHandler(linter: VhdlLinter, position: Position) {

  const token = await getTokenFromPosition(linter, position);
  if (!token || token.isIdentifier() === false) {
    throw new ResponseError(ErrorCodes.InvalidRequest, 'Can not rename this element',  'Can not rename this element' );
  }

  return token.range;
}
export async function renameHandler(linter: VhdlLinter, position: Position, newName: string) {
  const tokens = await findReferenceAndDefinition(linter, position);
  if (!tokens) {
    throw new ResponseError(ErrorCodes.InvalidRequest, 'Can not rename this element', 'Can not rename this element');
  }
  const changes: {[key: string]: TextEdit[]} = {};
  for (const token of tokens) {
    const uri = token.file.uri.toString();
    if (!Array.isArray(changes[uri])) {
      changes[uri] = [];
    }
    changes[uri].push(TextEdit.replace(token.range, newName));
  }
  return {
    changes
  };
}