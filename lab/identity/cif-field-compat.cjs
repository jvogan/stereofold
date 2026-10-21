'use strict';

/**
 * Mol* 5.12 / upstream #1943 field-name compatibility for parsed 5.11 CIFs.
 * Keep exact names first, original field/category metadata and all values.
 * This function is dependency-free so the stock detailed-view page can use
 * the same adapter without rewriting source bytes or its prebuilt viewer.
 */
function applyCifFieldCaseCompatibility(file) {
  function adapt(frame) {
    for (const category of Object.values(frame.categories)) {
      const exact = category.getField.bind(category);
      const normalized = Object.create(null);
      for (const name of category.fieldNames) normalized[name.toLowerCase()] = exact(name);
      category.getField = name => exact(name) ?? normalized[name.toLowerCase()];
    }
    for (const saved of frame.saveFrames ?? []) adapt(saved);
  }
  for (const frame of file.blocks) adapt(frame);
  return file;
}

module.exports = { applyCifFieldCaseCompatibility };
