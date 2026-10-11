/** A display filter over a verified assembly. It never changes atom identity. */
export function normalizeExperienceVisibility(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid assembly visibility.');
  const result = {};
  for (const key of Object.keys(value)) {
    if (!['entityIds', 'operatorNames', 'operatorIds', 'labelChains'].includes(key)) throw Error('Unknown assembly visibility field.');
    const items = value[key];
    if (!Array.isArray(items) || !items.length || items.length > 512
      || items.some(item => typeof item !== 'string' || !item.length || item.length > 256))
      throw Error('Assembly visibility requires a bounded, nonempty identifier list.');
    result[key] = [...new Set(items)];
  }
  if (!Object.keys(result).length) throw Error('Assembly visibility cannot be empty.');
  return result;
}

export function experienceVisibilityExpression(builder, value, structure) {
  const visible = normalizeExperienceVisibility(value);
  if (!visible) return undefined;
  if (visible.operatorIds) {
    const allowed = new Set(visible.operatorIds);
    visible.operatorNames = [...new Set((structure?.units ?? []).filter(unit => {
      const ids = unit.conformation.operator.assembly?.operList;
      return ids?.length && ids.every(id => allowed.has(id));
    }).map(unit => unit.conformation.operator.name))];
    if (!visible.operatorNames.length) throw Error('No assembly units match the declared operators.');
  }
  const tests = [];
  if (visible.entityIds) tests.push(builder.core.set.has([
    builder.set(...visible.entityIds), builder.struct.atomProperty.macromolecular.label_entity_id(),
  ]));
  if (visible.labelChains) tests.push(builder.core.set.has([
    builder.set(...visible.labelChains), builder.struct.atomProperty.macromolecular.label_asym_id(),
  ]));
  if (visible.operatorNames) tests.push(builder.core.set.has([
    builder.set(...visible.operatorNames), builder.struct.atomProperty.core.operatorName(),
  ]));
  return builder.struct.generator.atomGroups({ 'atom-test': tests.length === 1 ? tests[0] : builder.core.logic.and(tests) });
}
