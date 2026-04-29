require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const Groq = require('groq-sdk');

const app = express();
app.use(cors({ origin: '*' }));
const upload = multer({ storage: multer.memoryStorage() });

const API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

if (!API_KEY || API_KEY.trim() === '') {
    console.error('\x1b[41m\x1b[37m%s\x1b[0m', ' CRITICAL ERROR: .env file is missing or GROQ_API_KEY is not set. ');
    console.error('\x1b[31m%s\x1b[0m', 'The server will start, but the /api/extract-cad endpoint will return an error.');
} else {
    console.log('\x1b[32m%s\x1b[0m', `Groq API Key found. Length: ${API_KEY.length}`);
}
console.log(`Using Groq vision model: ${GROQ_MODEL}`);

const groq = new Groq({
    apiKey: API_KEY || 'invalid-key-placeholder',
    timeout: 20000,
    maxRetries: 0
});

const getGroqErrorDetails = (error) => {
    const cause = error?.cause?.cause || error?.cause;
    if (cause?.code === 'ENOTFOUND') {
        return 'Cannot reach api.groq.com. Check your internet/DNS connection and try again.';
    }
    if (error?.message === 'Connection error.') {
        return 'Could not connect to Groq. Check internet access and try again.';
    }
    return error?.message || 'Unknown Groq API error.';
};

const parseJsonResponse = (text) => {
    const cleanResponse = text
        .replace(/```json|```/g, '')
        .trim();

    try {
        return JSON.parse(cleanResponse);
    } catch {
        const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('AI response did not contain a JSON object.');
        }
        return JSON.parse(jsonMatch[0]);
    }
};

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const isVec = (value, length) =>
    Array.isArray(value) && value.length === length && value.every(isFiniteNumber);

const isPositiveVec3 = (value) => isVec(value, 3) && value.every((number) => number > 0);

const optionalVec3 = (value) => isVec(value, 3) ? value : undefined;

const allowedAxes = new Set(['x', 'y', 'z']);
const allowedHighSides = new Set(['left', 'right', 'front', 'back']);
const allowedGussetCorners = new Set(['frontBottom', 'backBottom']);
const allowedRoundedPlatePlanes = new Set(['xy', 'xz', 'yz']);

const sanitizeColor = (value, fallback) =>
    typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;

const sanitizeCornerRadii = (value) => {
    const source = value && typeof value === 'object' ? value : {};
    return ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'].reduce((radii, key) => {
        radii[key] = isFiniteNumber(source[key]) && source[key] > 0 ? source[key] : 0;
        return radii;
    }, {});
};

const sanitizeOperation = (operation) => {
    if (!operation || typeof operation !== 'object' || typeof operation.op !== 'string') {
        return null;
    }

    if (operation.op === 'box' || operation.op === 'cutBox') {
        if (!isPositiveVec3(operation.size) || !isVec(operation.position, 3)) return null;
        return {
            op: operation.op,
            name: typeof operation.name === 'string' ? operation.name : operation.op,
            size: operation.size,
            position: operation.position,
            ...(optionalVec3(operation.rotation) ? { rotation: operation.rotation } : {}),
            ...(operation.op === 'box' ? { color: sanitizeColor(operation.color, '#30cfd0') } : {})
        };
    }

    if (operation.op === 'roundedPlate') {
        if (!isPositiveVec3(operation.size) || !isVec(operation.position, 3)) return null;
        const cornerRadii = sanitizeCornerRadii(operation.cornerRadii);
        if (!Object.values(cornerRadii).some((radius) => radius > 0)) return null;
        return {
            op: 'roundedPlate',
            name: typeof operation.name === 'string' ? operation.name : 'rounded plate',
            size: operation.size,
            position: operation.position,
            plane: allowedRoundedPlatePlanes.has(operation.plane) ? operation.plane : 'xy',
            cornerRadii,
            color: sanitizeColor(operation.color, '#30cfd0')
        };
    }

    if (operation.op === 'cylinder' || operation.op === 'cutCylinder') {
        if (!isFiniteNumber(operation.radius) || !isFiniteNumber(operation.height) || operation.radius <= 0 || operation.height <= 0 || !isVec(operation.position, 3)) return null;
        return {
            op: operation.op,
            name: typeof operation.name === 'string' ? operation.name : operation.op,
            radius: operation.radius,
            height: operation.height,
            position: operation.position,
            axis: allowedAxes.has(operation.axis) ? operation.axis : 'z',
            ...(operation.op === 'cylinder' ? { color: sanitizeColor(operation.color, '#30cfd0') } : {})
        };
    }

    if (operation.op === 'wedge' || operation.op === 'cutWedge') {
        if (!isPositiveVec3(operation.size) || !isVec(operation.position, 3)) return null;
        return {
            op: operation.op,
            name: typeof operation.name === 'string' ? operation.name : operation.op,
            size: operation.size,
            position: operation.position,
            ...(optionalVec3(operation.rotation) ? { rotation: operation.rotation } : {}),
            highSide: allowedHighSides.has(operation.highSide) ? operation.highSide : 'left',
            ...(operation.op === 'wedge' ? { color: sanitizeColor(operation.color, '#30cfd0') } : {})
        };
    }

    if (operation.op === 'gusset') {
        if (!isPositiveVec3(operation.size) || !isVec(operation.position, 3)) return null;
        return {
            op: 'gusset',
            name: typeof operation.name === 'string' ? operation.name : 'gusset',
            size: operation.size,
            position: operation.position,
            corner: allowedGussetCorners.has(operation.corner) ? operation.corner : 'backBottom',
            color: sanitizeColor(operation.color, '#ff8a3d')
        };
    }

    if (operation.op === 'triangularPrism') {
        if (!Array.isArray(operation.points) || operation.points.length < 3 || !operation.points.slice(0, 3).every((point) => isVec(point, 2))) return null;
        if (!isFiniteNumber(operation.depth) || operation.depth <= 0) return null;
        return {
            op: operation.op,
            name: typeof operation.name === 'string' ? operation.name : operation.op,
            points: operation.points.slice(0, 3),
            depth: operation.depth,
            ...(isVec(operation.position, 3) ? { position: operation.position } : {}),
            ...(optionalVec3(operation.rotation) ? { rotation: operation.rotation } : {}),
            color: sanitizeColor(operation.color, '#ff8a3d')
        };
    }

    if (operation.op === 'polyhedron') {
        if (!Array.isArray(operation.points) || operation.points.length < 4 || !operation.points.every((point) => isVec(point, 3))) return null;
        if (!Array.isArray(operation.faces)) return null;
        const faces = operation.faces.filter((face) =>
            Array.isArray(face) &&
            face.length >= 3 &&
            face.every((index) => Number.isInteger(index) && index >= 0 && index < operation.points.length)
        );
        if (faces.length === 0) return null;
        return {
            op: operation.op,
            name: typeof operation.name === 'string' ? operation.name : operation.op,
            points: operation.points,
            faces,
            ...(isVec(operation.position, 3) ? { position: operation.position } : {}),
            color: sanitizeColor(operation.color, '#30cfd0')
        };
    }

    return null;
};

const sanitizePart = (part) => {
    if (!part || typeof part !== 'object' || typeof part.type !== 'string') return null;

    if (part.type === 'box') {
        if (!isPositiveVec3(part.size) || !isVec(part.position, 3)) return null;
        return {
            type: 'box',
            name: typeof part.name === 'string' ? part.name : 'box',
            size: part.size,
            position: part.position,
            color: sanitizeColor(part.color, '#30cfd0')
        };
    }

    if (part.type === 'triangularPrism') {
        if (!Array.isArray(part.points) || part.points.length < 3 || !part.points.slice(0, 3).every((point) => isVec(point, 2))) return null;
        if (!isFiniteNumber(part.depth) || part.depth <= 0) return null;
        return {
            type: 'triangularPrism',
            name: typeof part.name === 'string' ? part.name : 'triangular prism',
            points: part.points.slice(0, 3),
            depth: part.depth,
            ...(isVec(part.position, 3) ? { position: part.position } : {}),
            ...(optionalVec3(part.rotation) ? { rotation: part.rotation } : {}),
            color: sanitizeColor(part.color, '#ff8a3d')
        };
    }

    if (part.type === 'cylinder') {
        if (!isFiniteNumber(part.radius) || !isFiniteNumber(part.depth) || part.radius <= 0 || part.depth <= 0 || !isVec(part.position, 3)) return null;
        return {
            type: 'cylinder',
            name: typeof part.name === 'string' ? part.name : 'cylinder',
            radius: part.radius,
            depth: part.depth,
            position: part.position,
            ...(optionalVec3(part.rotation) ? { rotation: part.rotation } : {}),
            color: sanitizeColor(part.color, '#111111')
        };
    }

    if (part.type === 'mesh') {
        if (!Array.isArray(part.vertices) || part.vertices.length < 3 || !part.vertices.every((point) => isVec(point, 3))) return null;
        if (!Array.isArray(part.faces)) return null;
        const faces = part.faces.filter((face) =>
            Array.isArray(face) &&
            face.length >= 3 &&
            face.every((index) => Number.isInteger(index) && index >= 0 && index < part.vertices.length)
        );
        if (faces.length === 0) return null;
        return {
            type: 'mesh',
            name: typeof part.name === 'string' ? part.name : 'mesh',
            vertices: part.vertices,
            faces,
            color: sanitizeColor(part.color, '#30cfd0')
        };
    }

    return null;
};

const sanitizeCadResponse = (data, notes = '') => {
    const assumptions = Array.isArray(data?.assumptions)
        ? data.assumptions.filter((item) => typeof item === 'string')
        : [];

    const rawOperations = Array.isArray(data?.operations) ? data.operations : [];
    const operations = rawOperations.map(sanitizeOperation).filter(Boolean);
    const convertibleFilletCount = rawOperations.filter((operation) =>
        operation &&
        typeof operation === 'object' &&
        operation.op === 'fillet' &&
        (operation.radius === 10 || operation.radius === 15)
    ).length;
    const droppedOperations = Math.max(0, rawOperations.length - operations.length - convertibleFilletCount);

    const rawParts = Array.isArray(data?.parts) ? data.parts : [];
    const parts = rawParts.map(sanitizePart).filter(Boolean);
    const droppedParts = rawParts.length - parts.length;

    if (droppedOperations > 0) {
        assumptions.push(`Dropped ${droppedOperations} invalid operation(s) returned by the AI.`);
    }
    if (droppedParts > 0) {
        assumptions.push(`Dropped ${droppedParts} invalid part(s) returned by the AI.`);
    }

    const sanitized = {
        units: typeof data?.units === 'string' ? data.units : 'mm',
        assumptions,
        operations,
        parts
    };

    repairLBracketBoxes(sanitized, notes);
    repairConnectedGusset(sanitized);
    applyDimensionHints(sanitized, notes);
    convertFilletsToRoundedPlates(sanitized, rawOperations, notes);
    dropNonOverlappingCuts(sanitized);
    return sanitized;
};

const getBoxEdge = (box, axisIndex, side) =>
    box.position[axisIndex] + (side === 'max' ? box.size[axisIndex] / 2 : -box.size[axisIndex] / 2);

const getBracketBoxes = (operations) => {
    const boxes = operations.filter((operation) => operation.op === 'box' || operation.op === 'roundedPlate');
    const base = boxes.find((box) => /base|plate/i.test(box.name || '') && box.size[1] <= Math.max(15, box.size[0] * 0.2))
        || boxes.find((box) => /base/i.test(box.name || ''));
    const vertical = boxes.find((box) => /vertical|back|wall|upright/i.test(box.name || '') && box !== base);
    return { base, vertical };
};

const repairLBracketBoxes = (cadData, notes) => {
    if (!Array.isArray(cadData.operations) || typeof notes !== 'string') return;
    if (!/base\s+plate|l\s*bracket|vertical\s+(?:back\s+)?plate/i.test(notes)) return;

    const { base, vertical } = getBracketBoxes(cadData.operations);
    if (!base || !vertical) return;

    if (base.size[1] > Math.max(20, base.size[0] * 0.25)) {
        const thickness = 10;
        base.size = [base.size[0], thickness, base.size[2]];
        base.position = [base.position[0], thickness / 2, base.position[2]];
        cadData.assumptions.push('Corrected the base from a solid block to a thin 10 mm base plate.');
    }

    if (vertical.size[2] > Math.max(20, base.size[2] * 0.25)) {
        vertical.size = [vertical.size[0], vertical.size[1], 10];
        cadData.assumptions.push('Corrected the vertical plate thickness to 10 mm.');
    }

    const baseTop = getBoxEdge(base, 1, 'max');
    const expectedVerticalY = baseTop + vertical.size[1] / 2;
    if (Math.abs(vertical.position[1] - expectedVerticalY) > 2) {
        vertical.position = [vertical.position[0], expectedVerticalY, vertical.position[2]];
        cadData.assumptions.push('Seated the vertical plate on top of the base plate so the bracket is connected.');
    }
};

const repairConnectedGusset = (cadData) => {
    if (!Array.isArray(cadData.operations)) return;

    const existingGussetIndex = cadData.operations.findIndex((operation) => operation.op === 'gusset');
    const ribIndex = existingGussetIndex >= 0 ? existingGussetIndex : cadData.operations.findIndex((operation) =>
        operation.op === 'triangularPrism' &&
        /rib|gusset|support/i.test(operation.name || '')
    );
    if (ribIndex < 0) return;

    const { base, vertical } = getBracketBoxes(cadData.operations);
    if (!base || !vertical) return;

    const original = cadData.operations[ribIndex];
    const baseTop = getBoxEdge(base, 1, 'max');
    const verticalCenterBehindBase = vertical.position[2] >= base.position[2];
    const verticalInnerZ = verticalCenterBehindBase
        ? getBoxEdge(vertical, 2, 'min')
        : getBoxEdge(vertical, 2, 'max');
    const requestedSize = Array.isArray(original.size) ? original.size : [];
    const depth = Math.min(
        isFiniteNumber(requestedSize[2]) && requestedSize[2] > 0 ? requestedSize[2] : 40,
        40,
        base.size[2] * 0.45
    );
    const height = Math.min(
        isFiniteNumber(requestedSize[1]) && requestedSize[1] > 0 ? requestedSize[1] : 40,
        40,
        vertical.size[1] * 0.45
    );
    const thickness = Math.min(
        isFiniteNumber(requestedSize[0]) && requestedSize[0] > 0 ? requestedSize[0] : 10,
        12,
        Math.max(8, base.size[0] * 0.1)
    );
    const zCenter = verticalCenterBehindBase ? verticalInnerZ - depth / 2 : verticalInnerZ + depth / 2;

    cadData.operations.splice(ribIndex, 1, {
        op: 'gusset',
        name: typeof original.name === 'string' ? original.name : 'connected triangular gusset',
        size: [thickness, height, depth],
        position: [
            isVec(original.position, 3) && original.position[0] >= getBoxEdge(base, 0, 'min') && original.position[0] <= getBoxEdge(base, 0, 'max')
                ? original.position[0]
                : base.position[0],
            baseTop + height / 2,
            zCenter
        ],
        corner: verticalCenterBehindBase ? 'backBottom' : 'frontBottom',
        color: '#ff8a3d'
    });
    cadData.assumptions.push('Normalized the rib/gusset so it connects the base plate and vertical plate instead of floating or spanning the full model depth.');
};

const applyDimensionHints = (cadData, notes) => {
    if (!Array.isArray(cadData.operations) || typeof notes !== 'string') return;
    const { vertical } = getBracketBoxes(cadData.operations);
    if (!vertical) return;

    const rightEdgeMatch = notes.match(/(\d+(?:\.\d+)?)\s*mm\s+from\s+(?:the\s+)?right\s+edge/i);
    if (rightEdgeMatch) {
        const offset = Number(rightEdgeMatch[1]);
        cadData.operations.forEach((operation) => {
            if (operation.op === 'cutCylinder' && /hole/i.test(operation.name || '') && operation.axis === 'z') {
                operation.position = [
                    getBoxEdge(vertical, 0, 'max') - offset,
                    operation.position[1],
                    vertical.position[2]
                ];
            }
        });
        cadData.assumptions.push(`Applied right-edge hole dimension: X = plate width - ${offset}mm.`);
    }
};

const operationBounds = (operation) => {
    if (!isVec(operation.position, 3) || !isPositiveVec3(operation.size)) return null;
    return operation.position.map((center, index) => [
        center - operation.size[index] / 2,
        center + operation.size[index] / 2
    ]);
};

const boundsOverlap = (a, b) =>
    a.every(([aMin, aMax], index) => aMax > b[index][0] && aMin < b[index][1]);

const dropNonOverlappingCuts = (cadData) => {
    if (!Array.isArray(cadData.operations)) return;
    const solidBounds = cadData.operations
        .filter((operation) => ['box', 'roundedPlate', 'wedge', 'gusset'].includes(operation.op))
        .map(operationBounds)
        .filter(Boolean);

    if (solidBounds.length === 0) return;

    const originalLength = cadData.operations.length;
    cadData.operations = cadData.operations.filter((operation) => {
        if (!['cutBox', 'cutWedge'].includes(operation.op)) return true;
        const cutBounds = operationBounds(operation);
        return cutBounds ? solidBounds.some((bounds) => boundsOverlap(cutBounds, bounds)) : true;
    });

    const dropped = originalLength - cadData.operations.length;
    if (dropped > 0) {
        cadData.assumptions.push(`Dropped ${dropped} cut operation(s) that did not overlap the generated solid.`);
    }
};

const hasFilletHint = (rawOperations, notes, radius) => {
    const rawHasRadius = rawOperations.some((operation) =>
        operation &&
        typeof operation === 'object' &&
        operation.op === 'fillet' &&
        operation.radius === radius
    );
    return rawHasRadius || new RegExp(`R\\s*${radius}\\b`, 'i').test(notes || '');
};

const replaceOperation = (operations, oldOperation, newOperation) => {
    const index = operations.indexOf(oldOperation);
    if (index >= 0) {
        operations.splice(index, 1, newOperation);
    }
};

const convertFilletsToRoundedPlates = (cadData, rawOperations, notes) => {
    if (!Array.isArray(cadData.operations)) return;
    const { base, vertical } = getBracketBoxes(cadData.operations);

    if (base && hasFilletHint(rawOperations, notes, 15)) {
        const roundedBase = {
            op: 'roundedPlate',
            name: 'base plate with R15 rounded front corners',
            size: base.size,
            position: base.position,
            plane: 'xz',
            cornerRadii: {
                topLeft: 0,
                topRight: 15,
                bottomRight: 15,
                bottomLeft: 0
            },
            color: sanitizeColor(base.color, '#30cfd0')
        };
        replaceOperation(cadData.operations, base, roundedBase);
        cadData.assumptions.push('Modeled the base plate R15 rounded outline corners instead of dropping the fillet.');
    }

    if (vertical && hasFilletHint(rawOperations, notes, 10)) {
        const roundedVertical = {
            op: 'roundedPlate',
            name: 'vertical plate with R10 rounded side corners',
            size: vertical.size,
            position: vertical.position,
            plane: 'xy',
            cornerRadii: {
                topLeft: 0,
                topRight: 10,
                bottomRight: 10,
                bottomLeft: 0
            },
            color: sanitizeColor(vertical.color, '#30cfd0')
        };
        replaceOperation(cadData.operations, vertical, roundedVertical);
        cadData.assumptions.push('Modeled the vertical plate R10 rounded outline corners instead of dropping the fillet.');
    }
};

const cadPrompt = (notes, imageCount) => `
You are a CAD reconstruction assistant. Analyze ${imageCount} uploaded engineering drawing image(s) and return ONLY a JSON object.

Goal:
- Reconstruct the 3D object from front, top, side, isometric, and dimension views when present.
- Use written dimensions first.
- Use the user's manual notes when dimensions are missing or ambiguous.
- If only one view is supplied, infer hidden sides conservatively and include assumptions.

User manual notes:
${notes || 'No manual notes supplied.'}

Return this preferred schema. Prefer "operations" over "parts":
{
  "units": "mm",
  "assumptions": ["short explanation of inferred/missing dimensions"],
  "operations": [
    {
      "op": "box",
      "name": "base block",
      "size": [widthX, heightY, depthZ],
      "position": [centerX, centerY, centerZ],
      "color": "#30cfd0"
    },
    {
      "op": "cutBox",
      "name": "rectangular pocket or step removal",
      "size": [widthX, heightY, depthZ],
      "position": [centerX, centerY, centerZ],
      "rotation": [rotX, rotY, rotZ]
    },
    {
      "op": "roundedPlate",
      "name": "plate with rounded outline corners",
      "size": [widthX, heightY, depthZ],
      "position": [centerX, centerY, centerZ],
      "plane": "xz",
      "cornerRadii": {
        "topLeft": 0,
        "topRight": 15,
        "bottomRight": 15,
        "bottomLeft": 0
      },
      "color": "#30cfd0"
    },
    {
      "op": "cylinder",
      "name": "boss or shaft",
      "radius": radius,
      "height": height,
      "position": [centerX, centerY, centerZ],
      "axis": "z",
      "color": "#30cfd0"
    },
    {
      "op": "cutCylinder",
      "name": "through hole",
      "radius": radius,
      "height": height,
      "position": [centerX, centerY, centerZ],
      "axis": "z"
    },
    {
      "op": "wedge",
      "name": "sloped ramp",
      "size": [widthX, heightY, depthZ],
      "position": [centerX, centerY, centerZ],
      "rotation": [rotX, rotY, rotZ],
      "highSide": "left",
      "color": "#30cfd0"
    },
    {
      "op": "gusset",
      "name": "triangular support rib",
      "size": [thicknessX, heightY, depthZ],
      "position": [centerX, centerY, centerZ],
      "corner": "backBottom",
      "color": "#ff8a3d"
    },
    {
      "op": "cutWedge",
      "name": "sloped or sliding face cut",
      "size": [widthX, heightY, depthZ],
      "position": [centerX, centerY, centerZ],
      "rotation": [rotX, rotY, rotZ],
      "highSide": "left"
    },
    {
      "op": "triangularPrism",
      "name": "rib or gusset",
      "points": [[x1,y1], [x2,y2], [x3,y3]],
      "depth": thicknessZ,
      "position": [x,y,z],
      "rotation": [rotX, rotY, rotZ],
      "color": "#ff8a3d"
    },
    {
      "op": "polyhedron",
      "name": "custom solid",
      "points": [[x,y,z], [x,y,z], [x,y,z]],
      "faces": [[0,1,2]],
      "position": [x,y,z],
      "color": "#30cfd0"
    }
  ],
  "parts": [
    {
      "type": "mesh",
      "name": "main body",
      "vertices": [[x,y,z], [x,y,z]],
      "faces": [[0,1,2], [0,2,3]],
      "color": "#30cfd0"
    },
    {
      "type": "box",
      "name": "rectangular feature",
      "size": [widthX, heightY, depthZ],
      "position": [centerX, centerY, centerZ],
      "color": "#30cfd0"
    },
    {
      "type": "triangularPrism",
      "name": "rib or gusset",
      "points": [[x1,y1], [x2,y2], [x3,y3]],
      "depth": thicknessZ,
      "position": [x,y,z],
      "rotation": [rotX, rotY, rotZ],
      "color": "#ff8a3d"
    },
    {
      "type": "cylinder",
      "name": "hole marker",
      "radius": radius,
      "depth": length,
      "position": [x,y,z],
      "rotation": [rotX, rotY, rotZ],
      "color": "#111111"
    }
  ]
}

Coordinate system:
- X = left/right width, Y = vertical height, Z = front/back depth.
- "position" is always the center of the solid or cut volume, not a corner.
- Place connected features so their faces touch or overlap slightly; do not leave gaps between connected solids.
- When a drawing says a hole is "25 mm from the right edge" on a 100 mm wide plate, the hole center is at X = 75, not X = 25.
- Do not add large decorative cut operations to approximate rounded corners or visual outline radii; include those limitations in assumptions unless the exact cut is dimensioned.

Operations are executed in order. "box", "cylinder", "wedge", "triangularPrism", and "polyhedron" add material.
"cutBox", "cutCylinder", and "cutWedge" remove material from all previous solids.
Allowed operation names are exactly: "box", "cutBox", "roundedPlate", "cylinder", "cutCylinder", "wedge", "cutWedge", "gusset", "triangularPrism", "polyhedron".
Never return unsupported operation names such as "sphere", "extrude", "union", "subtract", or "mesh" inside operations.
Every number must be a final numeric literal. Do not return formulas, variables, comments, strings, or math expressions like 44 + 80.
All "points" arrays must contain numeric coordinates only. All "faces" arrays must contain integer vertex indexes only, for example [0, 1, 2], never "012".
Use "operations" for blocks, steps, bosses, ramps, ribs, holes, slots, and sloped faces whenever possible.
Use "roundedPlate" for rectangular plates whose 2D outline has radius dimensions like R10 or R15. "plane" is the plate face plane: use "xz" for a horizontal base plate, "xy" for a vertical back plate, and "yz" for a side plate.
For "roundedPlate.cornerRadii", use keys "topLeft", "topRight", "bottomRight", and "bottomLeft" in that 2D plane. Use 0 for square corners.
Use "wedge" for raised/added sloped ramp material.
Use "gusset" for triangular support ribs between a base plate and a vertical wall. For an L bracket, prefer "gusset" over raw "triangularPrism".
For "gusset", size is [thickness across X, vertical height Y, front/back depth Z]. Use corner "backBottom" when the right-angle corner touches the rear vertical wall and base, or "frontBottom" when it touches the front vertical wall and base.
Use "cutWedge" for sloped cuts, sliding faces, angled top faces, chamfers, and removed ramp-shaped material.
Use "cutBox" for rectangular pockets, slots, and step removals.
Do not use "cutBox" to create a rib or gusset. A rib/gusset is added material.
highSide means the side where the wedge reaches full height: "left", "right", "front", or "back".
Use mesh in "parts" only when the shape cannot be represented by operations.
For holes, prefer "cutCylinder" instead of visual markers.
Only add holes when they are clearly drawn or dimensioned. Do not infer holes from shadows, stains, paper marks, or image artifacts.
If a sloped/slide face is visible in the drawing, do not approximate it as a plain box. Use "wedge" or "cutWedge".
Do not copy any template shape. Build the model from the uploaded drawing(s).
`.trim();

app.post('/api/extract-cad', upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'images', maxCount: 6 }
]), async (req, res) => {
    console.log('--- New Request Received ---');

    try {
        const files = [
            ...((req.files?.image) || []),
            ...((req.files?.images) || [])
        ];

        if (files.length === 0) {
            console.error('No image uploaded in request.');
            return res.status(400).json({ error: 'No image uploaded' });
        }

        console.log('Images received:', files.map((file) => file.size).join(', '));

        if (!API_KEY || API_KEY.trim() === '') {
            console.error('Server missing API key.');
            return res.status(500).json({ error: 'Server missing API key' });
        }

        const prompt = cadPrompt(req.body?.notes, files.length);
        const imageContent = files.map((file) => ({
            type: 'image_url',
            image_url: {
                url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`
            }
        }));

        let completion;
        let data;
        try {
            completion = await groq.chat.completions.create({
                model: GROQ_MODEL,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        ...imageContent
                    ]
                }],
                temperature: 0.1,
                response_format: { type: 'json_object' },
                max_completion_tokens: 4096
            });
            data = completion.choices?.[0]?.message?.content;
            if (!data) {
                throw new Error('Groq returned an empty response.');
            }
            console.log('AI raw response:', data);
        } catch (aiError) {
            console.error('Error from Groq API:', aiError);
            return res.status(502).json({ error: 'Groq API error', details: getGroqErrorDetails(aiError) });
        }

        let parsedJson;
        try {
            parsedJson = parseJsonResponse(data);
        } catch (parseError) {
            console.error('Failed to parse AI response. Raw text:', data);
            console.error('Parse error:', parseError);
            return res.status(500).json({ error: 'Failed to parse AI response', details: parseError.message });
        }

        const sanitizedJson = sanitizeCadResponse(parsedJson, req.body?.notes);
        if (sanitizedJson.operations.length === 0 && sanitizedJson.parts.length === 0) {
            return res.status(422).json({
                error: 'AI response did not contain any renderable CAD operations.',
                details: sanitizedJson.assumptions.join(' ') || 'The model response was empty or invalid.'
            });
        }

        res.json(sanitizedJson);
    } catch (error) {
        console.error('Error in /api/extract-cad:', error);
        res.status(500).json({ error: 'CAD extraction failed', details: error.message });
    }
});

app.use((err, req, res, next) => {
    console.error('GLOBAL CRASH:', err);
    res.status(500).send(err.message);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running at http://localhost:${PORT}`));
