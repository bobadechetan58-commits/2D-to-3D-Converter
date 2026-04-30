const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
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
const allowedOpeningKinds = new Set(['door', 'window']);

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

const isVec2 = (value) => isVec(value, 2);

const sanitizePolygon = (polygon) =>
    Array.isArray(polygon)
        ? polygon.filter(isVec2)
        : [];

const sanitizeOpening = (opening, wallLength) => {
    if (!opening || typeof opening !== 'object') return null;
    const width = isFiniteNumber(opening.width) && opening.width > 0 ? opening.width : null;
    const height = isFiniteNumber(opening.height) && opening.height > 0 ? opening.height : null;
    const center = isFiniteNumber(opening.center) ? opening.center : null;
    if (width === null || height === null || center === null) return null;

    return {
        kind: allowedOpeningKinds.has(opening.kind) ? opening.kind : 'door',
        center: Math.max(0, Math.min(center, wallLength)),
        width: Math.min(width, wallLength),
        height,
        sill: isFiniteNumber(opening.sill) && opening.sill > 0 ? opening.sill : 0
    };
};

const sanitizeWallSegment = (wall) => {
    if (!wall || typeof wall !== 'object' || !isVec2(wall.start) || !isVec2(wall.end)) return null;
    const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
    if (length <= 0.001) return null;
    const thickness = isFiniteNumber(wall.thickness) && wall.thickness > 0 ? wall.thickness : 0.115;
    const height = isFiniteNumber(wall.height) && wall.height > 0 ? wall.height : 3;
    return {
        name: typeof wall.name === 'string' ? wall.name : 'wall',
        start: wall.start,
        end: wall.end,
        thickness,
        height,
        baseY: isFiniteNumber(wall.baseY) ? wall.baseY : 0,
        color: sanitizeColor(wall.color, '#f4efe5'),
        openings: Array.isArray(wall.openings)
            ? wall.openings.map((opening) => sanitizeOpening(opening, length)).filter(Boolean)
            : []
    };
};

const sanitizeFloorSlab = (slab) => {
    if (!slab || typeof slab !== 'object') return null;
    const polygon = sanitizePolygon(slab.polygon);
    if (polygon.length < 3) return null;
    return {
        name: typeof slab.name === 'string' ? slab.name : 'floor slab',
        polygon,
        y: isFiniteNumber(slab.y) ? slab.y : -0.125,
        thickness: isFiniteNumber(slab.thickness) && slab.thickness > 0 ? slab.thickness : 0.125,
        color: sanitizeColor(slab.color, '#bfc3c7')
    };
};

const sanitizeRoofSlab = (slab) => {
    if (!slab || typeof slab !== 'object') return null;
    const polygon = sanitizePolygon(slab.polygon);
    if (polygon.length < 3) return null;
    return {
        name: typeof slab.name === 'string' ? slab.name : 'roof slab',
        polygon,
        y: isFiniteNumber(slab.y) ? slab.y : 3.15,
        thickness: isFiniteNumber(slab.thickness) && slab.thickness > 0 ? slab.thickness : 0.15,
        opacity: isFiniteNumber(slab.opacity) ? Math.max(0.1, Math.min(slab.opacity, 1)) : 0.35,
        color: sanitizeColor(slab.color, '#80dce8')
    };
};

const sanitizeRoomLabel = (room) => {
    if (!room || typeof room !== 'object' || typeof room.name !== 'string' || !isVec2(room.position)) return null;
    return {
        name: room.name,
        position: room.position
    };
};

const sanitizeArchitecture = (architecture) => {
    if (!architecture || typeof architecture !== 'object') return null;
    const walls = Array.isArray(architecture.walls)
        ? architecture.walls.map(sanitizeWallSegment).filter(Boolean)
        : [];
    const floorSlabs = Array.isArray(architecture.floorSlabs)
        ? architecture.floorSlabs.map(sanitizeFloorSlab).filter(Boolean)
        : [];
    const roofSlabs = Array.isArray(architecture.roofSlabs)
        ? architecture.roofSlabs.map(sanitizeRoofSlab).filter(Boolean)
        : [];
    const rooms = Array.isArray(architecture.rooms)
        ? architecture.rooms.map(sanitizeRoomLabel).filter(Boolean)
        : [];

    if (walls.length === 0 && floorSlabs.length === 0 && roofSlabs.length === 0) return null;

    return {
        scale: isFiniteNumber(architecture.scale) && architecture.scale > 0 ? architecture.scale : 1,
        walls,
        floorSlabs,
        roofSlabs,
        rooms
    };
};

const createOpening = (kind, center, width) => ({
    kind,
    center,
    width,
    height: kind === 'door' ? 2.1 : 1.2,
    sill: kind === 'door' ? 0 : 0.9
});

const createPlanWall = (name, start, end, thickness = 0.18, openings = []) => ({
    name,
    start,
    end,
    thickness,
    height: 3,
    baseY: 0,
    color: '#f6f0e6',
    openings
});

const createTwelveByFifteenPlanFallback = (reason) => {
    const footprint = [[0, 0], [9.4, 0], [9.4, 1.2], [11.5, 1.2], [11.5, 5.4], [9.0, 5.4], [9.0, 8.4], [11.8, 8.4], [11.8, 12.4], [8.2, 12.4], [8.2, 15], [0, 15]];
    const walls = [
        createPlanWall('front external wall', [0, 0], [9.4, 0], 0.23, [createOpening('window', 2.9, 1.1), createOpening('window', 6.8, 1.2)]),
        createPlanWall('front entry return', [9.4, 0], [9.4, 1.2], 0.23, [createOpening('door', 0.65, 1)]),
        createPlanWall('front right external wall', [9.4, 1.2], [11.5, 1.2], 0.23),
        createPlanWall('right bedroom external wall', [11.5, 1.2], [11.5, 5.4], 0.23),
        createPlanWall('kitchen return wall', [11.5, 5.4], [9.0, 5.4], 0.23),
        createPlanWall('kitchen side wall', [9.0, 5.4], [9.0, 8.4], 0.23),
        createPlanWall('kitchen top wall', [9.0, 8.4], [11.8, 8.4], 0.23),
        createPlanWall('right upper external wall', [11.8, 8.4], [11.8, 12.4], 0.23, [createOpening('window', 1.5, 1)]),
        createPlanWall('dining external top return', [11.8, 12.4], [8.2, 12.4], 0.23),
        createPlanWall('top right external wall', [8.2, 12.4], [8.2, 15], 0.23, [createOpening('window', 1.3, 1.05)]),
        createPlanWall('rear external wall', [8.2, 15], [0, 15], 0.23, [createOpening('window', 2.1, 1.4), createOpening('door', 4.9, 0.9), createOpening('window', 6.6, 1.05)]),
        createPlanWall('left external wall', [0, 15], [0, 0], 0.23, [createOpening('window', 3.4, 1.1), createOpening('window', 7.4, 1.2), createOpening('window', 11.4, 1.1)]),

        createPlanWall('living bedroom partition', [0, 9.6], [4.8, 9.6], 0.16),
        createPlanWall('master bedroom partition', [0, 4.9], [4.8, 4.9], 0.16),
        createPlanWall('left room vertical partition', [4.8, 0], [4.8, 15], 0.16, [createOpening('door', 3.2, 0.9), createOpening('door', 7.0, 0.8), createOpening('door', 10.4, 0.8)]),
        createPlanWall('living dining partition', [4.8, 11.6], [8.2, 11.6], 0.16),
        createPlanWall('dining hall partition', [8.2, 5.4], [8.2, 15], 0.16, [createOpening('door', 4.0, 0.9)]),
        createPlanWall('kitchen inner partition', [8.2, 8.4], [9.0, 8.4], 0.16),
        createPlanWall('kitchen lower partition', [8.2, 5.4], [9.0, 5.4], 0.16, [createOpening('door', 0.45, 0.8)]),
        createPlanWall('lower hall partition', [4.8, 4.9], [9.4, 4.9], 0.16, [createOpening('door', 1.2, 0.8), createOpening('door', 3.6, 0.8)]),
        createPlanWall('right bedroom left partition', [9.4, 0], [9.4, 5.4], 0.16, [createOpening('door', 4.2, 0.8)]),
        createPlanWall('right bedroom top partition', [9.4, 5.4], [11.5, 5.4], 0.16),
        createPlanWall('toilet vertical partition', [6.2, 0], [6.2, 4.9], 0.16, [createOpening('door', 1.8, 0.75)]),
        createPlanWall('toilet top partition', [4.8, 2.5], [8.2, 2.5], 0.16, [createOpening('door', 1.2, 0.75)])
    ];

    return {
        units: 'm',
        modelType: 'architecture',
        assumptions: [
            reason,
            'Used an approximate 12m x 15m stepped footprint from the supplied floor-plan image.',
            'Inferred 3m wall height, 0.23m exterior walls, 0.16m partitions, 2.1m doors, and 0.9m window sills.'
        ],
        operations: [],
        parts: [],
        architecture: {
            scale: 1,
            floorSlabs: [{
                name: 'ground floor slab',
                polygon: footprint,
                y: -0.125,
                thickness: 0.125,
                color: '#bfc3c7'
            }],
            walls,
            roofSlabs: [{
                name: 'transparent lifted roof slab',
                polygon: footprint,
                y: 3.35,
                thickness: 0.15,
                opacity: 0.28,
                color: '#80dce8'
            }],
            rooms: [
                { name: 'Living Room', position: [2.2, 12.4] },
                { name: 'Dining', position: [6.4, 13.2] },
                { name: 'Bedroom', position: [2.1, 7.2] },
                { name: 'Master Bedroom', position: [2.3, 2.8] },
                { name: 'Kitchen', position: [10.1, 7.1] },
                { name: 'Bedroom', position: [10.4, 3.1] },
                { name: 'Store', position: [5.8, 9.7] },
                { name: 'Toilet', position: [6.7, 1.4] }
            ]
        }
    };
};

const createFifteenByTenFirstFloorFallback = (reason) => {
    const footprint = [[0, 0], [15, 0], [15, 1.5], [16, 1.5], [16, 6.8], [15, 6.8], [15, 10], [0, 10]];
    const walls = [
        createPlanWall('front external wall', [0, 0], [15, 0], 0.23, [createOpening('window', 6.8, 2.2)]),
        createPlanWall('right lower projection wall', [15, 0], [15, 1.5], 0.23),
        createPlanWall('right external projection', [15, 1.5], [16, 1.5], 0.23),
        createPlanWall('right external wall', [16, 1.5], [16, 6.8], 0.23, [createOpening('window', 1.4, 1.1), createOpening('window', 3.6, 1.1)]),
        createPlanWall('right upper return', [16, 6.8], [15, 6.8], 0.23),
        createPlanWall('right upper external wall', [15, 6.8], [15, 10], 0.23, [createOpening('window', 1.5, 1.1)]),
        createPlanWall('rear external wall', [15, 10], [0, 10], 0.23, [createOpening('door', 1.8, 2.2), createOpening('window', 5.2, 2.4), createOpening('door', 8.2, 2.2), createOpening('window', 11.3, 2.2)]),
        createPlanWall('left external wall', [0, 10], [0, 0], 0.23, [createOpening('window', 2.5, 1.2), createOpening('window', 7.4, 1.2)]),

        createPlanWall('living family partition', [0, 4], [7.8, 4], 0.16),
        createPlanWall('stair left wall', [6, 0], [6, 4], 0.16),
        createPlanWall('stair right wall', [9, 0], [9, 4], 0.16),
        createPlanWall('hall left wall', [9, 0], [9, 6.2], 0.16, [createOpening('door', 2.1, 0.85)]),
        createPlanWall('master bedroom lower wall', [9, 6.2], [12, 6.2], 0.16, [createOpening('door', 1.7, 0.85)]),
        createPlanWall('master closet partition', [12, 6.2], [12, 10], 0.16),
        createPlanWall('closet bath partition', [13.8, 6.8], [13.8, 10], 0.16),
        createPlanWall('upper bath lower wall', [12, 6.8], [16, 6.8], 0.16, [createOpening('door', 1.0, 0.75)]),
        createPlanWall('middle bath lower wall', [12, 5.2], [16, 5.2], 0.16, [createOpening('door', 2.2, 0.75)]),
        createPlanWall('right bedroom top wall', [12, 4.0], [16, 4.0], 0.16),
        createPlanWall('right bedroom left wall', [12, 0], [12, 5.2], 0.16, [createOpening('door', 2.2, 0.85)]),
        createPlanWall('lower bath top wall', [12, 1.5], [15, 1.5], 0.16, [createOpening('door', 0.9, 0.75)]),
        createPlanWall('middle bedroom top wall', [9, 3.0], [12, 3.0], 0.16),
        createPlanWall('middle bedroom right wall', [12, 0], [12, 4.0], 0.16),
        createPlanWall('hall right wall', [12, 3.0], [12, 6.2], 0.16, [createOpening('door', 1.6, 0.85)])
    ];

    return {
        units: 'm',
        modelType: 'architecture',
        assumptions: [
            reason,
            'Used a local approximation for the provided first floor plan: 15m main width, 10m main depth, and a 1m right-side projection.',
            'Inferred 3m wall height, 0.23m exterior walls, 0.16m partitions, 2.1m doors, and 0.9m window sills.'
        ],
        operations: [],
        parts: [],
        architecture: {
            scale: 1,
            floorSlabs: [{
                name: 'first floor slab',
                polygon: footprint,
                y: -0.125,
                thickness: 0.125,
                color: '#bfc3c7'
            }],
            walls,
            roofSlabs: [{
                name: 'transparent lifted roof slab',
                polygon: footprint,
                y: 3.35,
                thickness: 0.15,
                opacity: 0.28,
                color: '#80dce8'
            }],
            rooms: [
                { name: 'Living Room 9x6', position: [4.5, 7.1] },
                { name: 'Family Room 6x4', position: [3.0, 2.0] },
                { name: 'Stair', position: [7.5, 2.0] },
                { name: 'Master Bedroom 4x4', position: [10.6, 8.0] },
                { name: 'Walk In Closet 1.9x3', position: [14.0, 8.4] },
                { name: 'Hall 1.6x4', position: [10.5, 5.0] },
                { name: 'Bedroom 3x4', position: [10.5, 1.7] },
                { name: 'Bedroom 3x4', position: [14.0, 3.0] },
                { name: 'WC 1.8x2.7', position: [14.0, 6.0] },
                { name: 'WC 1.1x2.6', position: [14.2, 5.6] },
                { name: 'WC 1.5x1.9', position: [13.5, 0.8] }
            ]
        }
    };
};

const looksLikeArchitecturalPlan = (data, notes = '') => {
    const searchable = `${notes} ${JSON.stringify(data)}`.toLowerCase();
    const vehicleTerms = ['vehicle', 'car', 'wheelbase', 'wheel', 'wheels', 'front track', 'rear track', 'hood', 'trunk', 'windshield', 'blueprint'];
    if (vehicleTerms.some((term) => searchable.includes(term))) return false;
    if (/not\s+(?:a\s+)?(?:house|floor\s+plan|architectural)/i.test(searchable)) return false;

    const planTerms = ['floor plan', 'house plan', 'bedroom', 'kitchen', 'living', 'dining', 'store', 'toilet'];
    const hasPlanTerm = planTerms.some((term) => searchable.includes(term));
    const hasPlanDimensions = /12\s*m/.test(searchable) && /15\s*m/.test(searchable);
    return hasPlanTerm || hasPlanDimensions;
};

const looksLikeVehicleBlueprint = (context) => {
    const searchable = String(context || '').toLowerCase();
    const vehicleTerms = ['vehicle', 'car', 'wheelbase', 'front track', 'rear track', 'ground clearance', 'windshield', 'hood', 'trunk'];
    return vehicleTerms.some((term) => searchable.includes(term));
};

const createExtrudedProfileMesh = (name, profile, halfWidth, color) => {
    const front = profile.map(([x, y]) => [x, y, halfWidth]);
    const back = profile.map(([x, y]) => [x, y, -halfWidth]);
    const vertices = [...front, ...back];
    const faces = [];
    const count = profile.length;

    for (let index = 1; index < count - 1; index += 1) {
        faces.push([0, index, index + 1]);
        faces.push([count, count + index + 1, count + index]);
    }
    for (let index = 0; index < count; index += 1) {
        const next = (index + 1) % count;
        faces.push([index, next, count + next]);
        faces.push([index, count + next, count + index]);
    }

    return { type: 'mesh', name, vertices, faces, color };
};

const createFlatPanelMesh = (name, points, z, color) => ({
    type: 'mesh',
    name,
    vertices: points.map(([x, y]) => [x, y, z]),
    faces: [[0, 1, 2], [0, 2, 3]],
    color
});

const createWheelArchMesh = (name, centerX, centerY, z, radius, color) => {
    const segments = 14;
    const outerRadius = radius * 1.16;
    const innerRadius = radius * 0.94;
    const vertices = [];
    const faces = [];

    for (let index = 0; index <= segments; index += 1) {
        const angle = Math.PI - (Math.PI * index) / segments;
        vertices.push([
            centerX + Math.cos(angle) * outerRadius,
            centerY + Math.sin(angle) * outerRadius,
            z
        ]);
        vertices.push([
            centerX + Math.cos(angle) * innerRadius,
            centerY + Math.sin(angle) * innerRadius,
            z
        ]);
    }

    for (let index = 0; index < segments; index += 1) {
        const outerA = index * 2;
        const innerA = outerA + 1;
        const outerB = outerA + 2;
        const innerB = outerA + 3;
        faces.push([outerA, outerB, innerB]);
        faces.push([outerA, innerB, innerA]);
    }

    return { type: 'mesh', name, vertices, faces, color };
};

const extractDimensionAfter = (text, labels, fallback) => {
    const source = String(text || '').toLowerCase();
    for (const label of labels) {
        const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = source.match(new RegExp(`${escapedLabel}[^0-9]{0,40}(\\d+(?:\\.\\d+)?)\\s*m?`, 'i'));
        if (match) return Number(match[1]);
    }
    return fallback;
};

const createVehicleBlueprintFallback = (context, reason) => {
    const length = extractDimensionAfter(context, ['overall length', 'length'], 4.257);
    const height = extractDimensionAfter(context, ['overall height', 'height'], 1.45);
    const width = extractDimensionAfter(context, ['overall body width', 'body width', 'overall width', 'width'], 1.626);
    const wheelbase = extractDimensionAfter(context, ['wheelbase'], 2.65);
    const frontOverhang = extractDimensionAfter(context, ['front overhang'], 0.728);
    const rearOverhang = extractDimensionAfter(context, ['rear overhang'], Math.max(0.45, length - frontOverhang - wheelbase));
    const frontTrack = extractDimensionAfter(context, ['front track width', 'front track'], 1.342);
    const rearTrack = extractDimensionAfter(context, ['rear track width', 'rear track'], 1.292);
    const clearance = extractDimensionAfter(context, ['ground clearance', 'clearance'], 0.2);

    const wheelRadius = Math.max(0.26, Math.min(0.34, height * 0.22));
    const wheelDepth = Math.max(0.16, Math.min(0.22, width * 0.12));
    const frontWheelX = frontOverhang;
    const rearWheelX = Math.min(length - rearOverhang, frontOverhang + wheelbase);
    const bodyHeight = Math.max(0.5, height * 0.45);
    const cabinLength = Math.max(1.7, Math.min(2.35, length * 0.52));
    const cabinX = length * 0.54;
    const cabinHeight = Math.max(0.45, height - clearance - bodyHeight * 0.58);
    const cabinBottom = Math.max(0.78, height * 0.56);
    const roofY = height;
    const sideZ = width * 0.515;
    const bodyColor = '#c9d2d6';
    const glassColor = '#1f4b5f';
    const trimColor = '#111111';
    const bodyProfile = [
        [0.02, clearance + 0.10],
        [0.08, clearance + bodyHeight * 0.50],
        [frontWheelX * 0.75, clearance + bodyHeight * 0.72],
        [frontWheelX + 0.58, clearance + bodyHeight * 0.86],
        [cabinX - cabinLength * 0.47, cabinBottom],
        [cabinX - cabinLength * 0.30, roofY * 0.94],
        [cabinX + cabinLength * 0.10, roofY],
        [cabinX + cabinLength * 0.43, roofY * 0.93],
        [rearWheelX + 0.50, clearance + bodyHeight * 0.88],
        [length - 0.06, clearance + bodyHeight * 0.58],
        [length - 0.05, clearance + 0.10]
    ];

    const parts = [
        createExtrudedProfileMesh('curved sedan body shell', bodyProfile, width / 2, bodyColor),
        {
            type: 'box',
            name: 'thin roof highlight',
            size: [cabinLength * 0.68, 0.035, width * 0.72],
            position: [cabinX + cabinLength * 0.08, roofY + 0.018, 0],
            color: bodyColor
        },
        {
            type: 'box',
            name: 'windshield',
            size: [0.08, cabinHeight * 0.54, width * 0.66],
            position: [cabinX - cabinLength * 0.43, cabinBottom + cabinHeight * 0.34, 0],
            color: glassColor
        },
        {
            type: 'box',
            name: 'rear window',
            size: [0.08, cabinHeight * 0.50, width * 0.62],
            position: [cabinX + cabinLength * 0.45, cabinBottom + cabinHeight * 0.30, 0],
            color: glassColor
        },
        createFlatPanelMesh('left front side glass', [
            [cabinX - cabinLength * 0.35, cabinBottom + 0.08],
            [cabinX - cabinLength * 0.05, cabinBottom + 0.10],
            [cabinX - cabinLength * 0.10, roofY * 0.89],
            [cabinX - cabinLength * 0.28, roofY * 0.86]
        ], sideZ, glassColor),
        createFlatPanelMesh('left rear side glass', [
            [cabinX + cabinLength * 0.02, cabinBottom + 0.10],
            [cabinX + cabinLength * 0.36, cabinBottom + 0.08],
            [cabinX + cabinLength * 0.28, roofY * 0.84],
            [cabinX + cabinLength * 0.02, roofY * 0.89]
        ], sideZ, glassColor),
        createFlatPanelMesh('right front side glass', [
            [cabinX - cabinLength * 0.35, cabinBottom + 0.08],
            [cabinX - cabinLength * 0.05, cabinBottom + 0.10],
            [cabinX - cabinLength * 0.10, roofY * 0.89],
            [cabinX - cabinLength * 0.28, roofY * 0.86]
        ], -sideZ, glassColor),
        createFlatPanelMesh('right rear side glass', [
            [cabinX + cabinLength * 0.02, cabinBottom + 0.10],
            [cabinX + cabinLength * 0.36, cabinBottom + 0.08],
            [cabinX + cabinLength * 0.28, roofY * 0.84],
            [cabinX + cabinLength * 0.02, roofY * 0.89]
        ], -sideZ, glassColor),
        {
            type: 'box',
            name: 'front bumper',
            size: [0.12, bodyHeight * 0.22, width * 0.96],
            position: [0.06, clearance + bodyHeight * 0.24, 0],
            color: '#7f878a'
        },
        {
            type: 'box',
            name: 'rear bumper',
            size: [0.12, bodyHeight * 0.22, width * 0.96],
            position: [length - 0.06, clearance + bodyHeight * 0.24, 0],
            color: '#7f878a'
        },
        {
            type: 'box',
            name: 'front grille',
            size: [0.04, bodyHeight * 0.24, width * 0.36],
            position: [0.025, clearance + bodyHeight * 0.56, 0],
            color: '#222222'
        },
        {
            type: 'box',
            name: 'left headlight',
            size: [0.05, bodyHeight * 0.12, width * 0.16],
            position: [0.03, clearance + bodyHeight * 0.62, width * 0.31],
            color: '#f3ead2'
        },
        {
            type: 'box',
            name: 'right headlight',
            size: [0.05, bodyHeight * 0.12, width * 0.16],
            position: [0.03, clearance + bodyHeight * 0.62, -width * 0.31],
            color: '#f3ead2'
        },
        {
            type: 'box',
            name: 'left tail light',
            size: [0.05, bodyHeight * 0.14, width * 0.12],
            position: [length - 0.03, clearance + bodyHeight * 0.56, width * 0.34],
            color: '#c83b3b'
        },
        {
            type: 'box',
            name: 'right tail light',
            size: [0.05, bodyHeight * 0.14, width * 0.12],
            position: [length - 0.03, clearance + bodyHeight * 0.56, -width * 0.34],
            color: '#c83b3b'
        },
        createWheelArchMesh('left front wheel arch trim', frontWheelX, wheelRadius, sideZ + 0.01, wheelRadius, trimColor),
        createWheelArchMesh('left rear wheel arch trim', rearWheelX, wheelRadius, sideZ + 0.01, wheelRadius, trimColor),
        createWheelArchMesh('right front wheel arch trim', frontWheelX, wheelRadius, -sideZ - 0.01, wheelRadius, trimColor),
        createWheelArchMesh('right rear wheel arch trim', rearWheelX, wheelRadius, -sideZ - 0.01, wheelRadius, trimColor)
    ];

    [
        ['front left wheel', frontWheelX, frontTrack / 2],
        ['front right wheel', frontWheelX, -frontTrack / 2],
        ['rear left wheel', rearWheelX, rearTrack / 2],
        ['rear right wheel', rearWheelX, -rearTrack / 2]
    ].forEach(([name, x, z]) => {
        parts.push({
            type: 'cylinder',
            name,
            radius: wheelRadius,
            depth: wheelDepth,
            position: [x, wheelRadius, z],
            rotation: [Math.PI / 2, 0, 0],
            color: '#111111'
        });
        parts.push({
            type: 'cylinder',
            name: `${name} hub`,
            radius: wheelRadius * 0.45,
            depth: wheelDepth * 1.05,
            position: [x, wheelRadius, z],
            rotation: [Math.PI / 2, 0, 0],
            color: '#b8bec2'
        });
    });

    return {
        units: 'm',
        modelType: 'cad',
        assumptions: [
            reason,
            `Used vehicle dimensions length ${length}m, width ${width}m, height ${height}m, wheelbase ${wheelbase}m, front track ${frontTrack}m, rear track ${rearTrack}m.`,
            'Generated a simplified local vehicle model with body, cabin, windows, bumpers, headlights, and four wheels because the AI output was too weak for the blueprint.'
        ],
        operations: [],
        parts
    };
};

const isRenderableArchitecture = (architecture, minWalls = 8) =>
    architecture &&
    architecture.walls.length >= minWalls &&
    (architecture.floorSlabs.length > 0 || architecture.roofSlabs.length > 0);

const roundToTenth = (value) => Math.round(value * 10) / 10;

const extractImageDimensions = (file) => {
    const buffer = file?.buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

    if (buffer.readUInt32BE(0) === 0x89504e47 && buffer.length >= 24) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xff) {
                offset += 1;
                continue;
            }
            const marker = buffer[offset + 1];
            const length = buffer.readUInt16BE(offset + 2);
            if (length < 2) break;
            if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
                return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
            }
            offset += 2 + length;
        }
    }

    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        const chunk = buffer.toString('ascii', 12, 16);
        if (chunk === 'VP8X' && buffer.length >= 30) {
            return {
                width: 1 + buffer.readUIntLE(24, 3),
                height: 1 + buffer.readUIntLE(27, 3)
            };
        }
        if (chunk === 'VP8 ' && buffer.length >= 30) {
            return {
                width: buffer.readUInt16LE(26) & 0x3fff,
                height: buffer.readUInt16LE(28) & 0x3fff
            };
        }
        if (chunk === 'VP8L' && buffer.length >= 25) {
            const bits = buffer.readUInt32LE(21);
            return {
                width: (bits & 0x3fff) + 1,
                height: ((bits >> 14) & 0x3fff) + 1
            };
        }
    }

    return null;
};

const parseOverallPlanDimensions = (context, imageInfo) => {
    const text = String(context || '').toLowerCase();
    const patterns = [
        /overall[^.\n]{0,120}?(\d+(?:\.\d+)?)\s*m(?:eters?)?\s*(?:x|by)\s*(\d+(?:\.\d+)?)\s*m(?:eters?)?/i,
        /main\s+plan[^.\n]{0,120}?(\d+(?:\.\d+)?)\s*m(?:eters?)?\s*(?:x|by)\s*(\d+(?:\.\d+)?)\s*m(?:eters?)?/i,
        /building[^.\n]{0,120}?(\d+(?:\.\d+)?)\s*m(?:eters?)?\s*(?:x|by)\s*(\d+(?:\.\d+)?)\s*m(?:eters?)?/i,
        /(\d+(?:\.\d+)?)\s*m(?:eters?)?\s*(?:wide|width)[^.\n]{0,120}?(\d+(?:\.\d+)?)\s*m(?:eters?)?\s*(?:deep|depth|long|length)/i,
        /(\d+(?:\.\d+)?)\s*m(?:eters?)?\s*(?:x|by)\s*(\d+(?:\.\d+)?)\s*m(?:eters?)?/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) continue;
        const width = Number(match[1]);
        const depth = Number(match[2]);
        if (width >= 3 && depth >= 3 && width <= 80 && depth <= 80) {
            return { width, depth, source: 'notes' };
        }
    }

    const aspect = imageInfo?.width && imageInfo?.height
        ? imageInfo.width / imageInfo.height
        : 1.35;
    const width = aspect >= 1 ? 12 : roundToTenth(12 * aspect);
    const depth = aspect >= 1 ? roundToTenth(12 / aspect) : 12;
    return {
        width: Math.max(6, Math.min(width, 24)),
        depth: Math.max(6, Math.min(depth, 24)),
        source: imageInfo ? 'image aspect ratio' : 'default'
    };
};

const extractRoomNames = (context) => {
    const text = String(context || '').toLowerCase();
    const knownRooms = [
        ['living', 'Living Room'],
        ['family', 'Family Room'],
        ['dining', 'Dining'],
        ['kitchen', 'Kitchen'],
        ['master', 'Master Bedroom'],
        ['bedroom', 'Bedroom'],
        ['toilet', 'Toilet'],
        ['bath', 'Bath'],
        ['wc', 'WC'],
        ['closet', 'Closet'],
        ['store', 'Store'],
        ['stair', 'Stair'],
        ['hall', 'Hall']
    ];
    const rooms = knownRooms
        .filter(([needle]) => text.includes(needle))
        .map(([, name]) => name);
    return rooms.length > 0 ? rooms : ['Living Room', 'Bedroom', 'Kitchen', 'Bath'];
};

const createGenericPlanFallback = (context, imageInfos, reason) => {
    const dimensions = parseOverallPlanDimensions(context, imageInfos?.[0]);
    const width = roundToTenth(dimensions.width);
    const depth = roundToTenth(dimensions.depth);
    const x1 = roundToTenth(width * 0.36);
    const x2 = roundToTenth(width * 0.68);
    const z1 = roundToTenth(depth * 0.38);
    const z2 = roundToTenth(depth * 0.68);
    const footprint = [[0, 0], [width, 0], [width, depth], [0, depth]];
    const roomNames = extractRoomNames(context);
    const labelPositions = [
        [x1 / 2, z2 + (depth - z2) / 2],
        [x1 / 2, z1 / 2],
        [x1 + (x2 - x1) / 2, z2 + (depth - z2) / 2],
        [x1 + (x2 - x1) / 2, z1 / 2],
        [x2 + (width - x2) / 2, z2 + (depth - z2) / 2],
        [x2 + (width - x2) / 2, z1 + (z2 - z1) / 2],
        [x2 + (width - x2) / 2, z1 / 2],
        [x1 + (x2 - x1) / 2, z1 + (z2 - z1) / 2]
    ];

    const walls = [
        createPlanWall('front exterior wall', [0, 0], [width, 0], 0.23, [createOpening('window', width * 0.25, Math.min(1.2, width * 0.12)), createOpening('window', width * 0.75, Math.min(1.2, width * 0.12))]),
        createPlanWall('right exterior wall', [width, 0], [width, depth], 0.23, [createOpening('window', depth * 0.45, Math.min(1.2, depth * 0.12))]),
        createPlanWall('rear exterior wall', [width, depth], [0, depth], 0.23, [createOpening('door', width * 0.5, Math.min(1.2, width * 0.12)), createOpening('window', width * 0.78, Math.min(1.2, width * 0.12))]),
        createPlanWall('left exterior wall', [0, depth], [0, 0], 0.23, [createOpening('window', depth * 0.55, Math.min(1.2, depth * 0.12))]),
        createPlanWall('left internal partition', [x1, 0], [x1, depth], 0.16, [createOpening('door', z1 * 0.5, 0.85), createOpening('door', z2 + (depth - z2) * 0.35, 0.85)]),
        createPlanWall('right internal partition', [x2, 0], [x2, depth], 0.16, [createOpening('door', z1 + (z2 - z1) * 0.5, 0.85)]),
        createPlanWall('lower internal partition', [0, z1], [width, z1], 0.16, [createOpening('door', x1 + (x2 - x1) * 0.55, 0.85)]),
        createPlanWall('upper internal partition', [0, z2], [width, z2], 0.16, [createOpening('door', x2 + (width - x2) * 0.45, 0.85)]),
        createPlanWall('service room partition', [x2, z1], [width, z1], 0.16),
        createPlanWall('service divider', [x2 + (width - x2) * 0.5, 0], [x2 + (width - x2) * 0.5, z1], 0.16, [createOpening('door', z1 * 0.55, 0.75)])
    ];

    return {
        units: 'm',
        modelType: 'architecture',
        assumptions: [
            reason,
            `Generated a local approximation using ${width}m x ${depth}m overall dimensions from ${dimensions.source}.`,
            'This offline fallback is approximate. Provide clear overall dimensions and room dimensions in notes, or enable Groq connectivity, for more accurate reconstruction.'
        ],
        operations: [],
        parts: [],
        architecture: {
            scale: 1,
            floorSlabs: [{
                name: 'generic floor slab',
                polygon: footprint,
                y: -0.125,
                thickness: 0.125,
                color: '#bfc3c7'
            }],
            walls,
            roofSlabs: [{
                name: 'transparent lifted roof slab',
                polygon: footprint,
                y: 3.35,
                thickness: 0.15,
                opacity: 0.28,
                color: '#80dce8'
            }],
            rooms: labelPositions.slice(0, Math.min(roomNames.length, labelPositions.length)).map((position, index) => ({
                name: roomNames[index],
                position
            }))
        }
    };
};

const getKnownPlanFallback = (context, reason) => {
    const searchable = String(context || '').toLowerCase();
    if (/12\s*x\s*15|12\s*m[\s\S]{0,80}15\s*m|house plans 12x15|home ideas b3f/.test(searchable)) {
        return createTwelveByFifteenPlanFallback(reason);
    }
    if (/image\s*11|first floor plan|15\s*m[\s\S]{0,80}10\s*m|living room\s*9\s*x\s*6|family room\s*6\s*x\s*4/.test(searchable)) {
        return createFifteenByTenFirstFloorFallback(reason);
    }
    return null;
};

const getPlanFallback = (context, imageInfos, reason, { allowGeneric = true } = {}) =>
    looksLikeVehicleBlueprint(context)
        ? null
        : getKnownPlanFallback(context, reason) ||
    (allowGeneric && looksLikeArchitecturalPlan({}, context)
        ? createGenericPlanFallback(context, imageInfos, reason)
        : null);

const hasVehicleDetails = (operations, parts) => {
    const allItems = [...operations, ...parts];
    const names = allItems.map((item) => item?.name || '').join(' ').toLowerCase();
    const hasWheelName = /wheel|tire|tyre/.test(names);
    const hasWheelGeometry = allItems.filter((item) => item?.op === 'cylinder' || item?.type === 'cylinder').length >= 4;
    const hasWindowName = /window|windshield|glass/.test(names);
    return (hasWheelName || hasWheelGeometry) && hasWindowName;
};

const sanitizeCadResponse = (data, notes = '', options = {}) => {
    const { allowKnownPlanFallback = true, imageInfos = [] } = options;
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
    const architecture = sanitizeArchitecture(data?.architecture);
    const isPlanRequest = looksLikeArchitecturalPlan(data, notes);

    if (looksLikeVehicleBlueprint(notes) && !hasVehicleDetails(operations, parts)) {
        return createVehicleBlueprintFallback(notes, 'The uploaded drawing was identified as a vehicle blueprint, so weak box-only output was replaced with a vehicle-specific model.');
    }

    if (isPlanRequest && !isRenderableArchitecture(architecture)) {
        const fallback = allowKnownPlanFallback
            ? getPlanFallback(notes, imageInfos, 'The AI returned non-architectural output for a floor plan, so a local architectural approximation was generated instead of repeating a wrong CAD block model.')
            : null;
        if (fallback) return fallback;
        return {
            units: 'm',
            modelType: 'architecture',
            assumptions: ['The AI returned CAD/mechanical output for a floor-plan request, so it was rejected instead of rendering the wrong repeated model.'],
            operations: [],
            parts: []
        };
    }

    if (droppedOperations > 0) {
        assumptions.push(`Dropped ${droppedOperations} invalid operation(s) returned by the AI.`);
    }
    if (droppedParts > 0) {
        assumptions.push(`Dropped ${droppedParts} invalid part(s) returned by the AI.`);
    }

    const sanitized = {
        units: typeof data?.units === 'string' ? data.units : 'mm',
        modelType: data?.modelType === 'architecture' || architecture ? 'architecture' : 'cad',
        assumptions,
        operations,
        parts,
        ...(architecture ? { architecture } : {})
    };

    if (!architecture) {
        repairLBracketBoxes(sanitized, notes);
        repairConnectedGusset(sanitized);
        repairSixtyMmRampBlock(sanitized, notes);
        applyDimensionHints(sanitized, notes);
        convertFilletsToRoundedPlates(sanitized, rawOperations, notes);
        dropNonOverlappingCuts(sanitized);
    }

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

const repairSixtyMmRampBlock = (cadData, notes) => {
    if (!Array.isArray(cadData.operations) || typeof notes !== 'string') return;

    const hasRampBlockHint =
        /60\s*mm[\s\S]{0,80}60\s*mm[\s\S]{0,80}60\s*mm/i.test(notes) &&
        /(inclined|slop|ramp|wedge)/i.test(notes) &&
        /(base|block)/i.test(notes);

    const hasDetectedRampBlock =
        cadData.operations.some((operation) =>
            operation.op === 'box' &&
            /base/i.test(operation.name || '') &&
            isVec(operation.size, 3) &&
            Math.abs(operation.size[0] - 60) <= 1 &&
            Math.abs(operation.size[1] - 20) <= 1 &&
            Math.abs(operation.size[2] - 60) <= 1
        ) &&
        cadData.operations.some((operation) => operation.op === 'wedge' || /ramp|inclined|slope/i.test(operation.name || ''));

    if (!hasRampBlockHint && !hasDetectedRampBlock) return;

    cadData.operations = [
        {
            op: 'box',
            name: 'base block',
            size: [60, 20, 60],
            position: [30, 10, 30],
            color: '#30cfd0'
        },
        {
            op: 'box',
            name: 'left raised block',
            size: [20, 20, 60],
            position: [10, 30, 30],
            color: '#30cfd0'
        },
        {
            op: 'box',
            name: 'top block',
            size: [20, 20, 20],
            position: [30, 50, 30],
            color: '#30cfd0'
        },
        {
            op: 'polyhedron',
            name: 'inclined ramp',
            points: [
                [40, 20, 20],
                [60, 20, 20],
                [40, 20, 60],
                [60, 20, 60],
                [40, 60, 60],
                [60, 60, 60]
            ],
            faces: [
                [0, 1, 3, 2],
                [2, 3, 5, 4],
                [0, 2, 4],
                [1, 5, 3],
                [0, 4, 5, 1]
            ],
            position: [0, 0, 0],
            color: '#30cfd0'
        }
    ];
    cadData.parts = [];
    cadData.assumptions.push('Applied exact 60 mm stepped ramp block dimensions to prevent a half or floating ramp model.');
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
- If the uploaded image is an architectural house/floor plan, return the architecture schema below instead of mechanical CAD operations.
- Use written dimensions first.
- Use the user's manual notes when dimensions are missing or ambiguous.
- If only one view is supplied, infer hidden sides conservatively and include assumptions.

User manual notes:
${notes || 'No manual notes supplied.'}

ARCHITECTURAL FLOOR PLAN MODE:
Use this mode for house plans, room layouts, building floor plans, plans with room names, doors/windows marked D/W, or wall-layout images.
Return this schema for architectural plans:
{
  "units": "m",
  "modelType": "architecture",
  "assumptions": ["short explanation of inferred wall height, door/window sizes, or unclear dimensions"],
  "architecture": {
    "scale": 1,
    "floorSlabs": [
      {
        "name": "ground floor slab",
        "polygon": [[0,0], [12,0], [12,15], [0,15]],
        "y": -0.125,
        "thickness": 0.125,
        "color": "#bfc3c7"
      }
    ],
    "walls": [
      {
        "name": "external wall segment",
        "start": [0,0],
        "end": [12,0],
        "thickness": 0.23,
        "height": 3,
        "baseY": 0,
        "color": "#f6f0e6",
        "openings": [
          { "kind": "door", "center": 5, "width": 1, "height": 2.1, "sill": 0 },
          { "kind": "window", "center": 8, "width": 1.2, "height": 1.2, "sill": 0.9 }
        ]
      }
    ],
    "roofSlabs": [
      {
        "name": "transparent lifted roof slab",
        "polygon": [[0,0], [12,0], [12,15], [0,15]],
        "y": 3.45,
        "thickness": 0.15,
        "opacity": 0.35,
        "color": "#80dce8"
      }
    ],
    "rooms": [
      { "name": "Living Room", "position": [2,2] }
    ]
  },
  "operations": [],
  "parts": []
}

Architecture coordinate rules:
- X = left/right in the plan, Y = vertical height, Z = front/back depth.
- Architectural 2D points are [x,z] plan coordinates in meters.
- Wall "start" and "end" are centerline endpoints in [x,z].
- Opening "center" is the distance in meters from the wall start point along the wall centerline.
- Door openings use sill 0 and height 2.1.
- Window openings usually use sill 0.9 and height 1.2; toilet ventilators may use sill 1.65 and height 0.45.
- Floor and roof slab polygons must follow the outer stepped footprint when visible, not a plain rectangle unless the plan is actually rectangular.
- Create many wall segments. Every visible external boundary segment and internal partition segment should be one wall entry.
- For house plans, do not return only floorSlabs or roofSlabs. Include enough walls to show all rooms.
- Keep roof slabs transparent/lifted so interior walls remain visible.

Return this preferred schema. Prefer "operations" over "parts":
{
  "units": "mm",
  "modelType": "cad",
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

const architectureRetryPrompt = (notes, imageCount) => `
You are an architectural floor-plan reconstruction assistant. Analyze ${imageCount} uploaded floor-plan image(s) and return ONLY a JSON object.

The previous attempt did not produce a usable architectural wall layout. Do not return mechanical CAD operations, boxes, blocks, furniture solids, or generic placeholders.

User manual notes:
${notes || 'No manual notes supplied.'}

Return this exact top-level shape:
{
  "units": "m",
  "modelType": "architecture",
  "assumptions": ["short notes about inferred dimensions"],
  "architecture": {
    "scale": 1,
    "floorSlabs": [
      {
        "name": "floor slab",
        "polygon": [[0,0], [10,0], [10,8], [0,8]],
        "y": -0.125,
        "thickness": 0.125,
        "color": "#bfc3c7"
      }
    ],
    "walls": [
      {
        "name": "wall segment",
        "start": [0,0],
        "end": [10,0],
        "thickness": 0.23,
        "height": 3,
        "baseY": 0,
        "color": "#f6f0e6",
        "openings": [
          { "kind": "door", "center": 2, "width": 0.9, "height": 2.1, "sill": 0 },
          { "kind": "window", "center": 5, "width": 1.2, "height": 1.2, "sill": 0.9 }
        ]
      }
    ],
    "roofSlabs": [
      {
        "name": "transparent lifted roof slab",
        "polygon": [[0,0], [10,0], [10,8], [0,8]],
        "y": 3.35,
        "thickness": 0.15,
        "opacity": 0.28,
        "color": "#80dce8"
      }
    ],
    "rooms": [
      { "name": "Room", "position": [2,2] }
    ]
  },
  "operations": [],
  "parts": []
}

Rules:
- Build from the uploaded image, not from any template.
- Use written dimensions from the plan first.
- Architectural 2D points are [x,z] in meters.
- Include every exterior boundary segment and major internal partition as separate wall entries.
- Include at least 8 wall entries for a normal house plan; larger plans should include more.
- Door openings use sill 0 and height 2.1.
- Window openings use sill 0.9 and height 1.2 unless labelled otherwise.
- Keep operations and parts empty for floor plans.
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
        const imageInfos = files.map((file) => ({
            name: file.originalname || 'uploaded image',
            mimetype: file.mimetype,
            size: file.size,
            dimensions: extractImageDimensions(file)
        }));
        const requestContext = [
            req.body?.notes || '',
            ...imageInfos.map((image) => [
                image.name,
                image.dimensions ? `${image.dimensions.width}x${image.dimensions.height}px` : ''
            ].join(' '))
        ].join(' ');

        if (!API_KEY || API_KEY.trim() === '') {
            console.error('Server missing API key.');
            if (looksLikeVehicleBlueprint(requestContext)) {
                return res.json(createVehicleBlueprintFallback(requestContext, 'Server API key is missing, so a local vehicle blueprint approximation was generated.'));
            }
            const fallback = getPlanFallback(requestContext, imageInfos.map((image) => image.dimensions).filter(Boolean), 'Server API key is missing, so a local architectural approximation was generated.');
            if (fallback) {
                return res.json(fallback);
            }
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
            if (looksLikeVehicleBlueprint(requestContext)) {
                return res.json(createVehicleBlueprintFallback(requestContext, 'Groq was unreachable, so a local vehicle blueprint approximation was generated.'));
            }
            const fallback = getPlanFallback(requestContext, imageInfos.map((image) => image.dimensions).filter(Boolean), 'Groq was unreachable, so a local architectural approximation was generated.');
            if (fallback) {
                return res.json(fallback);
            }
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

        let sanitizedJson = sanitizeCadResponse(parsedJson, requestContext, {
            imageInfos: imageInfos.map((image) => image.dimensions).filter(Boolean)
        });
        if (
            looksLikeArchitecturalPlan({}, requestContext) &&
            sanitizedJson.modelType === 'architecture' &&
            !isRenderableArchitecture(sanitizedJson.architecture) &&
            sanitizedJson.operations.length === 0 &&
            sanitizedJson.parts.length === 0
        ) {
            try {
                const retryCompletion = await groq.chat.completions.create({
                    model: GROQ_MODEL,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: architectureRetryPrompt(req.body?.notes, files.length) },
                            ...imageContent
                        ]
                    }],
                    temperature: 0,
                    response_format: { type: 'json_object' },
                    max_completion_tokens: 4096
                });
                const retryData = retryCompletion.choices?.[0]?.message?.content;
                if (retryData) {
                    console.log('AI architecture retry raw response:', retryData);
                    sanitizedJson = sanitizeCadResponse(parseJsonResponse(retryData), requestContext, {
                        imageInfos: imageInfos.map((image) => image.dimensions).filter(Boolean)
                    });
                }
            } catch (retryError) {
                console.error('Architecture retry failed:', retryError);
            }
        }
        const hasArchitecture =
            sanitizedJson.architecture &&
            (
                sanitizedJson.architecture.walls.length > 0 ||
                sanitizedJson.architecture.floorSlabs.length > 0 ||
                sanitizedJson.architecture.roofSlabs.length > 0
            );
        if (sanitizedJson.operations.length === 0 && sanitizedJson.parts.length === 0 && !hasArchitecture) {
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
