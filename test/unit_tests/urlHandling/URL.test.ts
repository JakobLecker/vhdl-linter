import { expect, test } from '@jest/globals';
import { fileURLToPath, pathToFileURL } from 'url';
import { normalizeUri } from '../../../lib/normalize-uri';

let example: string, examplePath: string;
if (process.platform === "win32") {
    example = `file:///c%3A/Users/anton/Documents/vhdl-linter/test/unit_tests/rename/test%20a/architecture_split.vhd`;
    examplePath = `c:\\Users\\anton\\Documents\\vhdl-linter\\test\\unit_tests\\rename\\test a\\architecture_split.vhd`;
} else {
    example = `file:///testPath/test%20a/architecture_split.vhd`;
    examplePath = `/testPath/test a/architecture_split.vhd`;

}
test('tesing node URL', () => {
    const normalizedURL = normalizeUri(example);
    const url = new URL(normalizedURL);
    const path = fileURLToPath(url);
    expect(path).toEqual(examplePath);
    // expect(url.pathname).toEqual(examplePath); // Thats the wrong one
    expect(pathToFileURL(path).toString()).toBe(normalizedURL);
});
// test('tesing vscode URI', () => {
//     const url = URI.parse(example)
//     const path = url.fsPath;
//     expect(path).toEqual(examplePath)
//     expect(url.toString()).toBe(example);
//     console.log(URI.file(path).toString());
//     expect(URI.file(path).toString()).toBe(example);
// });