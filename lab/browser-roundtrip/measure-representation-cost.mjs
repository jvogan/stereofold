// node .../measure-representation-cost.mjs [atoms bonds residues]
// No device, coordinates, network, WebGL or runtime dependency required.
import { estimateRepresentation, geometryBudgetDecision, GEOMETRY_LEVELS } from './representation-budget.mjs';
const args = process.argv.slice(2).map(Number);
const structures = args.length ? [{ name: 'input', atoms: args[0], bonds: args[1], residues: args[2] }]
  : [{ name: '1CRN', atoms: 327, residues: 46 }, { name: '4HHB (probe approximation)', atoms: 4400, residues: 801 }];
console.log(JSON.stringify(structures.map(structure => ({ ...structure,
  assumption: 'Missing bonds estimated as ceil(atoms * 1.2); mesh-equivalent vertices per eye, not measured GPU time.',
  estimates: ['ball-and-stick', 'spacefill', 'molecular-surface', 'cartoon'].map(representation => ({ representation,
    levels: GEOMETRY_LEVELS.map(level => estimateRepresentation({ ...structure, representation, level })),
    quest2: geometryBudgetDecision({ ...structure, representation, presenting: true, deviceClass: 'quest2', quality: 'low', standalone: true }),
  })),
})), null, 2));
