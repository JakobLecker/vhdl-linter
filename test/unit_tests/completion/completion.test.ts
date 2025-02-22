import { expect, test } from '@jest/globals';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { Elaborate } from '../../../lib/elaborate/elaborate';
import { getCompletions } from '../../../lib/languageFeatures/completion';
import { ProjectParser } from '../../../lib/project-parser';
import { defaultSettingsWithOverwrite } from '../../../lib/settings';
import { VhdlLinter } from '../../../lib/vhdl-linter';
import { readFileSyncNorm } from "../../readFileSyncNorm";

test.each([
  ['lowercase', 'std_ulogic_vector', 'STD_ULOGIC_VECTOR'],
  ['UPPERCASE', 'STD_ULOGIC_VECTOR', 'std_ulogic_vector']
])('testing completion %s shall contain %s shall not contain %s', async (ieeeCasing, shallContain, shallNotContain) => {
  const uri = pathToFileURL(join(__dirname, 'test_completion.vhd'));
  const getter = defaultSettingsWithOverwrite({
    style:
    {
      ieeeCasing: ieeeCasing as 'lowercase' | 'UPPERCASE'
    }
  });
  const linter = new VhdlLinter(uri, readFileSyncNorm(uri, { encoding: 'utf8' }),
    await ProjectParser.create([], '', getter), getter);
  await Elaborate.elaborate(linter);
  const completion = await getCompletions(linter, {
    textDocument: {
      uri: uri.toString()
    },
    position: {
      line: 9,
      character: 13
    }
  });
  expect(completion).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        "label": shallContain
      })
    ])
  );
  expect(completion).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        "label": shallNotContain
      })
    ])
  );
});