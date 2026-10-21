import { applyCifFieldCaseCompatibility } from '../../lab/identity/cif-field-compat.cjs';

/** The stock mmCIF provider's two transforms, with compatibility between them. */
export function createCompatibleMmcifTrajectoryLoader(adapt: typeof applyCifFieldCaseCompatibility) {
  return async function parseCompatibleMmcifTrajectory(plugin: any, data: any, transforms: any) {
    const parsed = plugin.state.data.build().to(data)
      .apply(transforms.Data.ParseCif, undefined, { state: { isGhost: true } });
    await parsed.commit({ revertOnError: true });
    const cif = parsed.selector;
    cif.checkValid();
    try {
      adapt(cif.obj.data);
      const built = plugin.state.data.build().to(cif)
        .apply(transforms.Model.TrajectoryFromMmCif);
      await built.commit({ revertOnError: true });
      const trajectory = built.selector;
      trajectory.checkValid();
      if (cif.obj.data.blocks.length > 1) plugin.state.data.updateCellState(cif.ref, { isGhost: false });
      return trajectory;
    } catch (error) {
      // Preserve the provider's rollback boundary if trajectory construction fails.
      await plugin.state.data.build().delete(cif.ref).commit();
      throw error;
    }
  };
}

export const parseCompatibleMmcifTrajectory = createCompatibleMmcifTrajectoryLoader(applyCifFieldCaseCompatibility);
export const COMPATIBLE_MMCIF_TRAJECTORY_SOURCE = `(${createCompatibleMmcifTrajectoryLoader.toString()})(${applyCifFieldCaseCompatibility.toString()})`;
