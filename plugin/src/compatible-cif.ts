import { CIF as MolstarCIF } from 'molstar/lib/commonjs/mol-io/reader/cif.js';
import { Task } from 'molstar/lib/commonjs/mol-task/task.js';
import { applyCifFieldCaseCompatibility } from '../../lab/identity/cif-field-compat.cjs';

// Source/tsx entry points do not pass through the packaged vendor transform.
// Keep the actual parser's progress, cancellation, errors and source values.
export const CIF = {
  ...MolstarCIF,
  parse(data: Parameters<typeof MolstarCIF.parse>[0]) {
    const task = MolstarCIF.parse(data);
    return Task.create(task.name, async ctx => {
      const result = await task.runInContext(ctx);
      if (!result.isError) applyCifFieldCaseCompatibility(result.result);
      return result;
    });
  },
};
