import React, { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Stage, Text } from '@react-three/drei';
import * as THREE from 'three';
import { booleans, extrusions, geometries, primitives, transforms } from '@jscad/modeling';

interface Rib {
  width: number;
  height: number;
}

interface LegacyCadData {
  profile: [number, number][];
  depth: number;
  rib: Rib;
}

interface BoxPart {
  type: 'box';
  name?: string;
  size: [number, number, number];
  position: [number, number, number];
  color?: string;
}

interface TriangularPrismPart {
  type: 'triangularPrism';
  name?: string;
  points: [number, number][];
  depth: number;
  position?: [number, number, number];
  rotation?: [number, number, number];
  color?: string;
}

interface CylinderPart {
  type: 'cylinder';
  name?: string;
  radius: number;
  depth: number;
  position: [number, number, number];
  rotation?: [number, number, number];
  color?: string;
}

interface MeshPart {
  type: 'mesh';
  name?: string;
  vertices: [number, number, number][];
  faces: [number, number, number][];
  color?: string;
}

interface BoxOperation {
  op: 'box';
  name?: string;
  size: [number, number, number];
  position: [number, number, number];
  rotation?: [number, number, number];
  color?: string;
}

interface CutBoxOperation {
  op: 'cutBox';
  name?: string;
  size: [number, number, number];
  position: [number, number, number];
  rotation?: [number, number, number];
}

interface CornerRadii {
  topLeft?: number;
  topRight?: number;
  bottomRight?: number;
  bottomLeft?: number;
}

interface RoundedPlateOperation {
  op: 'roundedPlate';
  name?: string;
  size: [number, number, number];
  position: [number, number, number];
  plane: 'xy' | 'xz' | 'yz';
  cornerRadii: CornerRadii;
  color?: string;
}

interface CylinderOperation {
  op: 'cylinder';
  name?: string;
  radius: number;
  height: number;
  position: [number, number, number];
  axis?: 'x' | 'y' | 'z';
  color?: string;
}

interface CutCylinderOperation {
  op: 'cutCylinder';
  name?: string;
  radius: number;
  height: number;
  position: [number, number, number];
  axis?: 'x' | 'y' | 'z';
}

interface WedgeOperation {
  op: 'wedge';
  name?: string;
  size: [number, number, number];
  position: [number, number, number];
  rotation?: [number, number, number];
  highSide?: 'left' | 'right' | 'front' | 'back';
  color?: string;
}

interface GussetOperation {
  op: 'gusset';
  name?: string;
  size: [number, number, number];
  position: [number, number, number];
  corner?: 'frontBottom' | 'backBottom';
  color?: string;
}

interface CutWedgeOperation {
  op: 'cutWedge';
  name?: string;
  size: [number, number, number];
  position: [number, number, number];
  rotation?: [number, number, number];
  highSide?: 'left' | 'right' | 'front' | 'back';
}

interface TriangularPrismOperation {
  op: 'triangularPrism';
  name?: string;
  points: [number, number][];
  depth: number;
  position?: [number, number, number];
  rotation?: [number, number, number];
  color?: string;
}

interface PolyhedronOperation {
  op: 'polyhedron';
  name?: string;
  points: [number, number, number][];
  faces: number[][];
  position?: [number, number, number];
  color?: string;
}

type CadOperation =
  | BoxOperation
  | CutBoxOperation
  | RoundedPlateOperation
  | CylinderOperation
  | CutCylinderOperation
  | WedgeOperation
  | GussetOperation
  | CutWedgeOperation
  | TriangularPrismOperation
  | PolyhedronOperation;

type CadPart = BoxPart | TriangularPrismPart | CylinderPart | MeshPart;

interface ArchitectureOpening {
  kind: 'door' | 'window';
  center: number;
  width: number;
  height: number;
  sill: number;
}

interface ArchitectureWall {
  name?: string;
  start: [number, number];
  end: [number, number];
  thickness: number;
  height: number;
  baseY?: number;
  color?: string;
  openings?: ArchitectureOpening[];
}

interface ArchitectureSlab {
  name?: string;
  polygon: [number, number][];
  y: number;
  thickness: number;
  opacity?: number;
  color?: string;
}

interface ArchitectureRoom {
  name: string;
  position: [number, number];
}

interface ArchitectureData {
  scale?: number;
  walls?: ArchitectureWall[];
  floorSlabs?: ArchitectureSlab[];
  roofSlabs?: ArchitectureSlab[];
  rooms?: ArchitectureRoom[];
}

interface AssemblyCadData {
  units?: string;
  modelType?: 'cad' | 'architecture';
  assumptions?: string[];
  operations?: CadOperation[];
  parts?: CadPart[];
  architecture?: ArchitectureData;
}

type CadData = LegacyCadData | AssemblyCadData;
type Solid = ReturnType<typeof primitives.cuboid>;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isVec3 = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);

const isVec2 = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);

const normalizeRotation = (rotation?: [number, number, number]): [number, number, number] => {
  if (!rotation) return [0, 0, 0];
  const looksLikeDegrees = rotation.some((value) => Math.abs(value) > Math.PI * 2);
  return looksLikeDegrees
    ? rotation.map((value) => THREE.MathUtils.degToRad(value)) as [number, number, number]
    : rotation;
};

const orientSolid = (solid: Solid, axis: 'x' | 'y' | 'z' = 'z') => {
  if (axis === 'x') return transforms.rotateY(Math.PI / 2, solid);
  if (axis === 'y') return transforms.rotateX(Math.PI / 2, solid);
  return solid;
};

const rotateAndTranslate = (solid: Solid, position: [number, number, number], rotation?: [number, number, number]) => {
  const rotated = transforms.rotate(normalizeRotation(rotation), solid);
  return transforms.translate(position, rotated);
};

type WedgeLikeOperation = Pick<WedgeOperation, 'size' | 'highSide'>;

const createWedge = (operation: WedgeLikeOperation) => {
  const [width, height, depth] = operation.size;
  const x0 = -width / 2;
  const x1 = width / 2;
  const y0 = -height / 2;
  const y1 = height / 2;
  const z0 = -depth / 2;
  const z1 = depth / 2;
  const highSide = operation.highSide ?? 'left';

  if (highSide === 'right') {
    return primitives.polyhedron({
      points: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x1, y1, z0], [x1, y1, z1]],
      faces: [[0, 1, 2, 3], [1, 4, 5, 2], [0, 4, 1], [3, 2, 5], [0, 3, 5, 4]],
      orientation: 'outward',
    });
  }

  if (highSide === 'front') {
    return primitives.polyhedron({
      points: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0]],
      faces: [[0, 1, 2, 3], [0, 4, 5, 1], [0, 3, 4], [1, 5, 2], [3, 2, 5, 4]],
      orientation: 'outward',
    });
  }

  if (highSide === 'back') {
    return primitives.polyhedron({
      points: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x1, y1, z1], [x0, y1, z1]],
      faces: [[0, 1, 2, 3], [3, 2, 4, 5], [0, 1, 4, 5], [1, 2, 4], [0, 5, 3]],
      orientation: 'outward',
    });
  }

  return primitives.polyhedron({
    points: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x0, y1, z1]],
    faces: [[0, 1, 2, 3], [0, 3, 5, 4], [0, 4, 1], [3, 2, 5], [1, 4, 5, 2]],
    orientation: 'outward',
  });
};

const createGusset = (operation: GussetOperation) => {
  const [thickness, height, depth] = operation.size;
  const x0 = -thickness / 2;
  const x1 = thickness / 2;
  const y0 = -height / 2;
  const y1 = height / 2;
  const z0 = -depth / 2;
  const z1 = depth / 2;

  const points: [number, number, number][] = operation.corner === 'frontBottom'
    ? [[x0, y0, z0], [x0, y0, z1], [x0, y1, z0], [x1, y0, z0], [x1, y0, z1], [x1, y1, z0]]
    : [[x0, y0, z1], [x0, y0, z0], [x0, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z1]];

  return primitives.polyhedron({
    points,
    faces: [[0, 1, 2], [5, 4, 3], [0, 3, 4, 1], [1, 4, 5, 2], [2, 5, 3, 0]],
    orientation: 'outward',
  });
};

const getRadius = (cornerRadii: CornerRadii, corner: keyof CornerRadii, maxRadius: number) =>
  Math.max(0, Math.min(cornerRadii[corner] ?? 0, maxRadius));

const createRoundedRectanglePoints = (width: number, height: number, cornerRadii: CornerRadii) => {
  const x0 = -width / 2;
  const x1 = width / 2;
  const y0 = -height / 2;
  const y1 = height / 2;
  const maxRadius = Math.min(width, height) / 2;
  const segments = 10;
  const points: [number, number][] = [];

  const addCorner = (centerX: number, centerY: number, radius: number, startDeg: number, endDeg: number, fallback: [number, number]) => {
    if (radius <= 0) {
      points.push(fallback);
      return;
    }

    for (let i = 0; i <= segments; i++) {
      const angle = THREE.MathUtils.degToRad(startDeg + ((endDeg - startDeg) * i) / segments);
      points.push([centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius]);
    }
  };

  const bottomRight = getRadius(cornerRadii, 'bottomRight', maxRadius);
  const topRight = getRadius(cornerRadii, 'topRight', maxRadius);
  const topLeft = getRadius(cornerRadii, 'topLeft', maxRadius);
  const bottomLeft = getRadius(cornerRadii, 'bottomLeft', maxRadius);

  addCorner(x1 - bottomRight, y0 + bottomRight, bottomRight, -90, 0, [x1, y0]);
  addCorner(x1 - topRight, y1 - topRight, topRight, 0, 90, [x1, y1]);
  addCorner(x0 + topLeft, y1 - topLeft, topLeft, 90, 180, [x0, y1]);
  addCorner(x0 + bottomLeft, y0 + bottomLeft, bottomLeft, 180, 270, [x0, y0]);

  return points;
};

const createRoundedPlate = (operation: RoundedPlateOperation) => {
  const [widthX, heightY, depthZ] = operation.size;
  const [profileWidth, profileHeight, thickness] =
    operation.plane === 'xy'
      ? [widthX, heightY, depthZ]
      : operation.plane === 'xz'
        ? [widthX, depthZ, heightY]
        : [depthZ, heightY, widthX];

  const points = createRoundedRectanglePoints(profileWidth, profileHeight, operation.cornerRadii);
  const profile = primitives.polygon({ points, orientation: 'counterclockwise' });
  const extruded = transforms.translate([0, 0, -thickness / 2], extrusions.extrudeLinear({ height: thickness }, profile));

  if (operation.plane === 'xy') {
    return transforms.translate(operation.position, extruded);
  }

  if (operation.plane === 'xz') {
    return transforms.translate(operation.position, transforms.rotateX(Math.PI / 2, extruded));
  }

  return transforms.translate(operation.position, transforms.rotateY(Math.PI / 2, extruded));
};

const createTriangularPrism = (operation: TriangularPrismOperation) => {
  if (operation.points.length < 3 || !operation.points.slice(0, 3).every(isVec2) || !isFiniteNumber(operation.depth)) {
    return null;
  }

  const points = operation.points.slice(0, 3);
  const front = points.map(([x, y]) => [x, y, -operation.depth / 2] as [number, number, number]);
  const back = points.map(([x, y]) => [x, y, operation.depth / 2] as [number, number, number]);
  const solid = primitives.polyhedron({
    points: [...front, ...back],
    faces: [[0, 1, 2], [5, 4, 3], [0, 3, 4, 1], [1, 4, 5, 2], [2, 5, 3, 0]],
    orientation: 'outward',
  });
  const rotated = transforms.rotate(normalizeRotation(operation.rotation), solid);
  return transforms.translate(operation.position ?? [0, 0, 0], rotated);
};

const operationToSolid = (operation: CadOperation): Solid | null => {
  if (operation.op === 'box' || operation.op === 'cutBox') {
    if (!isVec3(operation.size) || !isVec3(operation.position)) return null;
    const box = primitives.cuboid({ size: operation.size, center: [0, 0, 0] });
    return rotateAndTranslate(box, operation.position, operation.rotation);
  }

  if (operation.op === 'roundedPlate') {
    if (!isVec3(operation.size) || !isVec3(operation.position)) return null;
    return createRoundedPlate(operation);
  }

  if (operation.op === 'wedge' || operation.op === 'cutWedge') {
    if (!isVec3(operation.size) || !isVec3(operation.position)) return null;
    return rotateAndTranslate(createWedge(operation), operation.position, operation.rotation);
  }

  if (operation.op === 'gusset') {
    if (!isVec3(operation.size) || !isVec3(operation.position)) return null;
    return transforms.translate(operation.position, createGusset(operation));
  }

  if (operation.op === 'triangularPrism') {
    return createTriangularPrism(operation);
  }

  if (operation.op === 'polyhedron') {
    if (!Array.isArray(operation.points) || !Array.isArray(operation.faces)) return null;
    if (!operation.points.every(isVec3) || !operation.faces.every((face) => Array.isArray(face) && face.length >= 3)) return null;
    const solid = primitives.polyhedron({ points: operation.points, faces: operation.faces, orientation: 'outward' });
    return transforms.translate(operation.position ?? [0, 0, 0], solid);
  }

  if (operation.op !== 'cylinder' && operation.op !== 'cutCylinder') {
    return null;
  }

  if (!isFiniteNumber(operation.radius) || !isFiniteNumber(operation.height) || operation.radius <= 0 || operation.height <= 0 || !isVec3(operation.position)) {
    return null;
  }

  const cylinder = primitives.cylinder({
    radius: operation.radius,
    height: operation.height,
    center: [0, 0, 0],
    segments: 64,
  });
  return transforms.translate(operation.position, orientSolid(cylinder, operation.axis));
};

const operationsToGeometry = (operations: CadOperation[]) => {
  const solids: Solid[] = [];

  operations.forEach((operation) => {
    const solid = operationToSolid(operation);
    if (!solid) return;
    if (operation.op === 'cutCylinder' || operation.op === 'cutBox' || operation.op === 'cutWedge') {
      if (solids.length > 0) {
        const base = solids.length === 1 ? solids[0] : booleans.union(...solids);
        solids.splice(0, solids.length, booleans.subtract(base, solid));
      }
      return;
    }
    solids.push(solid);
  });

  if (solids.length === 0) {
    return new THREE.BufferGeometry();
  }

  const finalSolid = solids.length === 1 ? solids[0] : booleans.union(...solids);
  const polygons = geometries.geom3.toPolygons(finalSolid);
  const positions: number[] = [];

  polygons.forEach((polygon) => {
    const vertices = polygon.vertices as [number, number, number][];
    for (let i = 1; i < vertices.length - 1; i++) {
      positions.push(...vertices[0], ...vertices[i], ...vertices[i + 1]);
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
};

const defaultCadData: AssemblyCadData = {
  units: 'mm',
  parts: [
    {
      type: 'box',
      name: 'base plate',
      size: [100, 8, 100],
      position: [50, 4, 50],
      color: '#30cfd0',
    },
    {
      type: 'box',
      name: 'vertical plate',
      size: [100, 100, 8],
      position: [50, 50, 96],
      color: '#30cfd0',
    },
    {
      type: 'triangularPrism',
      name: 'support rib',
      points: [[0, 0], [40, 0], [0, 40]],
      depth: 8,
      position: [50, 8, 55],
      rotation: [Math.PI / 2, 0, 0],
      color: '#ff8a3d',
    },
    {
      type: 'cylinder',
      name: 'hole marker',
      radius: 5,
      depth: 10,
      position: [65, 55, 91],
      rotation: [Math.PI / 2, 0, 0],
      color: '#111111',
    },
  ],
};

function isLegacyCadData(data: CadData): data is LegacyCadData {
  return 'profile' in data && Array.isArray(data.profile);
}

function LegacyBracketModel({ data }: { data: LegacyCadData }) {
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    if (data.profile.length > 0) {
      s.moveTo(data.profile[0][0], data.profile[0][1]);
      for (let i = 1; i < data.profile.length; i++) {
        s.lineTo(data.profile[i][0], data.profile[i][1]);
      }
      s.closePath();
    }
    return s;
  }, [data.profile]);

  return (
    <group>
      <mesh>
        <extrudeGeometry args={[shape, { depth: data.depth, bevelEnabled: false }]} />
        <meshStandardMaterial color="#30cfd0" metalness={0.35} roughness={0.25} />
      </mesh>
      <mesh position={[data.rib.width / 2, data.rib.height / 2, data.depth / 2]} rotation={[0, 0, -Math.PI / 4]}>
        <coneGeometry args={[data.rib.width / 2, data.rib.height, 4]} />
        <meshStandardMaterial color="#ff8a3d" metalness={0.2} roughness={0.45} />
      </mesh>
    </group>
  );
}

function TriangularPrism({ part }: { part: TriangularPrismPart }) {
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    part.points.forEach(([x, y], index) => {
      if (index === 0) s.moveTo(x, y);
      else s.lineTo(x, y);
    });
    s.closePath();
    return s;
  }, [part.points]);

  return (
    <mesh position={part.position ?? [0, 0, 0]} rotation={normalizeRotation(part.rotation)}>
      <extrudeGeometry args={[shape, { depth: part.depth, bevelEnabled: false }]} />
      <meshStandardMaterial color={part.color ?? '#ff8a3d'} metalness={0.2} roughness={0.45} />
    </mesh>
  );
}

function CadPartMesh({ part }: { part: CadPart }) {
  if (part.type === 'mesh') {
    return <MeshModel part={part} />;
  }

  if (part.type === 'box') {
    return (
      <mesh position={part.position}>
        <boxGeometry args={part.size} />
        <meshStandardMaterial color={part.color ?? '#30cfd0'} metalness={0.35} roughness={0.25} />
      </mesh>
    );
  }

  if (part.type === 'triangularPrism') {
    return <TriangularPrism part={part} />;
  }

  return (
    <mesh position={part.position} rotation={normalizeRotation(part.rotation)}>
      <cylinderGeometry args={[part.radius, part.radius, part.depth, 48]} />
      <meshStandardMaterial color={part.color ?? '#111111'} metalness={0.1} roughness={0.8} />
    </mesh>
  );
}

function MeshModel({ part }: { part: MeshPart }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const positions = part.faces.flatMap((face) =>
      face.flatMap((vertexIndex) => part.vertices[vertexIndex] ?? [0, 0, 0])
    );
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    return g;
  }, [part.faces, part.vertices]);

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color={part.color ?? '#30cfd0'} metalness={0.25} roughness={0.35} side={THREE.DoubleSide} />
    </mesh>
  );
}

function OperationModel({ operations }: { operations: CadOperation[] }) {
  const geometry = useMemo(() => operationsToGeometry(operations), [operations]);

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#30cfd0" metalness={0.3} roughness={0.32} side={THREE.DoubleSide} />
    </mesh>
  );
}

function ArchitectureSlabMesh({ slab, transparent = false }: { slab: ArchitectureSlab; transparent?: boolean }) {
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    slab.polygon.forEach(([x, z], index) => {
      if (index === 0) s.moveTo(x, z);
      else s.lineTo(x, z);
    });
    s.closePath();
    return s;
  }, [slab.polygon]);

  return (
    <mesh position={[0, slab.y + slab.thickness / 2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <extrudeGeometry args={[shape, { depth: slab.thickness, bevelEnabled: false }]} />
      <meshStandardMaterial
        color={slab.color ?? (transparent ? '#80dce8' : '#bfc3c7')}
        opacity={transparent ? slab.opacity ?? 0.35 : 1}
        transparent={transparent}
        roughness={0.45}
        metalness={0.05}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function WallPiece({
  localCenter,
  size,
  color,
}: {
  localCenter: [number, number, number];
  size: [number, number, number];
  color: string;
}) {
  if (size.some((value) => value <= 0.001)) return null;
  return (
    <mesh position={localCenter}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.62} metalness={0.02} />
    </mesh>
  );
}

function ArchitectureWallMesh({ wall }: { wall: ArchitectureWall }) {
  const dx = wall.end[0] - wall.start[0];
  const dz = wall.end[1] - wall.start[1];
  const length = Math.hypot(dx, dz);
  if (length <= 0.001) return null;

  const angle = Math.atan2(dz, dx);
  const midpoint: [number, number, number] = [(wall.start[0] + wall.end[0]) / 2, 0, (wall.start[1] + wall.end[1]) / 2];
  const baseY = wall.baseY ?? 0;
  const color = wall.color ?? '#f6f0e6';
  const thickness = wall.thickness;
  const openings = [...(wall.openings ?? [])]
    .filter((opening) => opening.width > 0 && opening.height > 0)
    .sort((a, b) => a.center - b.center);

  const pieces: React.ReactNode[] = [];
  let cursor = 0;

  openings.forEach((opening, index) => {
    const start = Math.max(0, opening.center - opening.width / 2);
    const end = Math.min(length, opening.center + opening.width / 2);
    const leftWidth = Math.max(0, start - cursor);
    if (leftWidth > 0.001) {
      pieces.push(
        <WallPiece
          key={`left-${index}`}
          localCenter={[cursor + leftWidth / 2 - length / 2, baseY + wall.height / 2, 0]}
          size={[leftWidth, wall.height, thickness]}
          color={color}
        />
      );
    }

    const openingWidth = Math.max(0, end - start);
    const bottomHeight = Math.max(0, opening.sill);
    const topStart = opening.sill + opening.height;
    const topHeight = Math.max(0, wall.height - topStart);
    const openingCenterX = start + openingWidth / 2 - length / 2;

    if (bottomHeight > 0.001) {
      pieces.push(
        <WallPiece
          key={`bottom-${index}`}
          localCenter={[openingCenterX, baseY + bottomHeight / 2, 0]}
          size={[openingWidth, bottomHeight, thickness]}
          color={color}
        />
      );
    }

    if (topHeight > 0.001) {
      pieces.push(
        <WallPiece
          key={`top-${index}`}
          localCenter={[openingCenterX, baseY + topStart + topHeight / 2, 0]}
          size={[openingWidth, topHeight, thickness]}
          color={color}
        />
      );
    }

    cursor = Math.max(cursor, end);
  });

  const rightWidth = Math.max(0, length - cursor);
  if (rightWidth > 0.001) {
    pieces.push(
      <WallPiece
        key="right"
        localCenter={[cursor + rightWidth / 2 - length / 2, baseY + wall.height / 2, 0]}
        size={[rightWidth, wall.height, thickness]}
        color={color}
      />
    );
  }

  return (
    <group position={midpoint} rotation={[0, -angle, 0]}>
      {pieces}
    </group>
  );
}

function ArchitectureRoomLabel({ room }: { room: ArchitectureRoom }) {
  return (
    <Text
      position={[room.position[0], 0.06, room.position[1]]}
      rotation={[-Math.PI / 2, 0, 0]}
      fontSize={0.28}
      color="#243033"
      anchorX="center"
      anchorY="middle"
      maxWidth={2.4}
      textAlign="center"
    >
      {room.name}
    </Text>
  );
}

function ArchitectureModel({ architecture }: { architecture: ArchitectureData }) {
  return (
    <group>
      {(architecture.floorSlabs ?? []).map((slab, index) => (
        <ArchitectureSlabMesh key={`floor-${slab.name ?? index}`} slab={slab} />
      ))}
      {(architecture.walls ?? []).map((wall, index) => (
        <ArchitectureWallMesh key={`wall-${wall.name ?? index}`} wall={wall} />
      ))}
      {(architecture.roofSlabs ?? []).map((slab, index) => (
        <ArchitectureSlabMesh key={`roof-${slab.name ?? index}`} slab={slab} transparent />
      ))}
      {(architecture.rooms ?? []).map((room, index) => (
        <ArchitectureRoomLabel key={`room-${room.name}-${index}`} room={room} />
      ))}
    </group>
  );
}

function CadModel({ data }: { data: CadData }) {
  if (isLegacyCadData(data)) {
    return <LegacyBracketModel data={data} />;
  }

  if (data.modelType === 'architecture' && data.architecture) {
    return <ArchitectureModel architecture={data.architecture} />;
  }

  return (
    <group>
      {data.architecture && <ArchitectureModel architecture={data.architecture} />}
      {data.operations && data.operations.length > 0 && <OperationModel operations={data.operations} />}
      {(data.parts ?? []).map((part, index) => (
        <CadPartMesh key={`${part.type}-${part.name ?? index}`} part={part} />
      ))}
    </group>
  );
}

function App() {
  const [cadData, setCadData] = useState<CadData | null>(defaultCadData);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [dimensionNotes, setDimensionNotes] = useState('');

  const isValidCadData = (data: unknown): data is CadData => {
    const maybeData = data as Partial<LegacyCadData & AssemblyCadData>;
    const hasLegacyShape =
      Array.isArray(maybeData.profile) &&
      typeof maybeData.depth === 'number' &&
      !!maybeData.rib &&
      typeof maybeData.rib.width === 'number' &&
      typeof maybeData.rib.height === 'number';

    const hasAssemblyShape =
      (Array.isArray(maybeData.operations) && maybeData.operations.length > 0) ||
      (Array.isArray(maybeData.parts) && maybeData.parts.length > 0) ||
      !!maybeData.architecture;
    return hasLegacyShape || hasAssemblyShape;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSelectedFiles(Array.from(e.target.files ?? []));
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      setErrorMsg('Choose one or more drawing images first.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    setCadData(null);
    const formData = new FormData();
    selectedFiles.forEach((file) => formData.append('images', file));
    formData.append('notes', dimensionNotes);

    try {
      const response = await fetch('/api/extract-cad', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        setErrorMsg(err.details || err.error || 'Server error. Please try again.');
        return;
      }
      const data = await response.json();
      if (isValidCadData(data)) {
        setCadData(data);
      } else {
        setErrorMsg('Invalid CAD data received from server.');
      }
    } catch (error) {
      setErrorMsg('Upload failed. Please try again.');
      console.error('Upload failed', error);
    } finally {
      setLoading(false);
    }
  };

  const partCount = !cadData
    ? 0
    : isLegacyCadData(cadData)
    ? 2
    : cadData.modelType === 'architecture' && cadData.architecture
      ? (cadData.architecture.walls?.length ?? 0) +
        (cadData.architecture.floorSlabs?.length ?? 0) +
        (cadData.architecture.roofSlabs?.length ?? 0)
      : (cadData.operations?.length ?? 0) +
        (cadData.parts?.length ?? 0) +
        (cadData.architecture?.walls?.length ?? 0) +
        (cadData.architecture?.floorSlabs?.length ?? 0) +
        (cadData.architecture?.roofSlabs?.length ?? 0);

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#111' }}>
      <div style={{ width: '300px', padding: '20px', borderRight: '1px solid #444', color: 'white', overflowY: 'auto' }}>
        <h3>Smartboard AI 3D</h3>
        <input type="file" accept="image/*" multiple onChange={handleFileChange} />
        <textarea
          value={dimensionNotes}
          onChange={(e) => setDimensionNotes(e.target.value)}
          placeholder="Optional dimensions/notes: front width 100mm, depth 60mm, height 40mm, hole dia 10mm..."
          style={{
            width: '100%',
            minHeight: 90,
            marginTop: 12,
            padding: 8,
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
        <button
          type="button"
          onClick={handleUpload}
          disabled={loading}
          style={{ width: '100%', marginTop: 10, padding: 8, cursor: loading ? 'wait' : 'pointer' }}
        >
          {loading ? 'Analyzing...' : 'Generate 3D Model'}
        </button>
        {selectedFiles.length > 0 && <p>{selectedFiles.length} image{selectedFiles.length === 1 ? '' : 's'} selected</p>}
        {loading && <p>Analyzing drawing...</p>}
        {errorMsg && <p style={{ color: '#ff6b6b' }}>{errorMsg}</p>}

        <div style={{ marginTop: '20px' }}>
          <h4>Detected model</h4>
          <p>{partCount} renderable part{partCount === 1 ? '' : 's'}</p>
          {cadData && !isLegacyCadData(cadData) && cadData.assumptions && cadData.assumptions.length > 0 && (
            <pre style={{ fontSize: '12px', whiteSpace: 'pre-wrap', color: '#ffd166' }}>
              {cadData.assumptions.join('\n')}
            </pre>
          )}
          <pre style={{ fontSize: '12px', whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(cadData, null, 2)}
          </pre>
        </div>
      </div>

      <div style={{ flex: 1 }}>
        <Canvas shadows camera={{ position: [160, 130, 180], fov: 45 }}>
          <Stage environment="city" intensity={0.6}>
            {cadData && <CadModel data={cadData} />}
          </Stage>
          <OrbitControls makeDefault />
        </Canvas>
      </div>
    </div>
  );
}

export default App;
