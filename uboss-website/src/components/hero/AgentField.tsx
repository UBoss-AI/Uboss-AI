'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';

/**
 * The moving field behind the hero.
 *
 * ## Why a scene and not a video
 *
 * The reference this hero is modelled on runs a video loop behind the copy. A video would have
 * been simpler and it is the wrong answer here for two reasons: there is no footage of this
 * product that is not a screen recording, and a loop is the same eight seconds on every visit. The
 * scene below is different every time it is watched and weighs a few kilobytes of code rather than
 * a few megabytes of pixels.
 *
 * ## It is about something
 *
 * Decoration behind an enterprise headline reads as a stock asset. This draws what the product
 * actually is: **nodes of work, joined, with something travelling between them.** Violet nodes are
 * agents, the cyan ones are people — the site's own two colours, used the same way here as they
 * are in every diagram further down the page — and the pulses that run along the links are work
 * moving from one to the next. Somebody who reads the page then looks back at the hero sees the
 * same idea they have just been told.
 *
 * Slow on purpose: a full rotation takes about two minutes. Anything faster competes with the
 * headline, and the headline is what the hero is for.
 *
 * ## Cost, and what happens when it cannot be paid
 *
 * One draw call for the links, one for the nodes, one for the pulses — there is no per-node React
 * component and no state that changes on a frame. `frameloop="demand"` is deliberately *not* used,
 * because this animates continuously; instead the canvas stops entirely when the visitor has asked
 * for reduced motion, and the hero's own CSS puts a still gradient behind the copy either way, so
 * the text never depends on WebGL having started.
 */

const NODE_COUNT = 34;
const LINK_DISTANCE = 2.6;

/** Violet for agents, cyan for people — the same two the rest of the site uses. */
const AI = new THREE.Color('#8b5cf6');
const HUMAN = new THREE.Color('#22d3ee');

interface Link {
  from: number;
  to: number;
  /** Where along the link the pulse currently is, and how fast it travels. */
  offset: number;
  speed: number;
}

function Field(): React.JSX.Element {
  const group = useRef<THREE.Group>(null);
  const pulses = useRef<THREE.InstancedMesh>(null);

  /*
   * Positions, links and pulses, worked out once.
   *
   * Seeded by nothing — a different arrangement on every load is the point, and there is nothing
   * here a test or a screenshot needs to reproduce exactly.
   */
  const { positions, links, colors } = useMemo(() => {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < NODE_COUNT; i += 1) {
      /*
       * Spread over a flattened sphere rather than a cube.
       *
       * A cube of points reads as a grid from the front and as noise from the side. Flattening the
       * vertical axis keeps the field wide and shallow, which is the shape of the space behind a
       * headline — and stops nodes from piling up in front of the first word.
       */
      const angle = Math.random() * Math.PI * 2;
      const height = (Math.random() - 0.5) * 2;
      const radius = Math.sqrt(1 - height * height) * (3.9 + Math.random() * 2.2);
      points.push(
        new THREE.Vector3(Math.cos(angle) * radius, height * 1.5, Math.sin(angle) * radius),
      );
    }

    const found: Link[] = [];
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const a = points[i];
        const b = points[j];
        if (a === undefined || b === undefined) continue;
        if (a.distanceTo(b) < LINK_DISTANCE) {
          found.push({ from: i, to: j, offset: Math.random(), speed: 0.06 + Math.random() * 0.12 });
        }
      }
    }

    // One node in four is a person. The rest are agents — which is the ratio the product assumes.
    const tint = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i += 1) {
      const colour = i % 4 === 0 ? HUMAN : AI;
      tint[i * 3] = colour.r;
      tint[i * 3 + 1] = colour.g;
      tint[i * 3 + 2] = colour.b;
    }

    return { positions: points, links: found.slice(0, 90), colors: tint };
  }, []);

  const nodeGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        positions.flatMap((p) => [p.x, p.y, p.z]),
        3,
      ),
    );
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  }, [positions, colors]);

  const linkGeometry = useMemo(() => {
    const vertices: number[] = [];
    for (const link of links) {
      const a = positions[link.from];
      const b = positions[link.to];
      if (a === undefined || b === undefined) continue;
      vertices.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    return geometry;
  }, [links, positions]);

  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((state, delta) => {
    if (group.current) {
      // A full turn in about two minutes. Anything quicker competes with the headline.
      group.current.rotation.y += delta * 0.05;
      // A slight tilt that breathes, so the field never looks like a still image with a spin on it.
      group.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.08) * 0.09;
    }

    const mesh = pulses.current;
    if (!mesh) return;

    links.forEach((link, index) => {
      link.offset = (link.offset + delta * link.speed) % 1;
      const a = positions[link.from];
      const b = positions[link.to];
      if (a === undefined || b === undefined) return;

      dummy.position.lerpVectors(a, b, link.offset);
      /*
       * Each pulse fades in and out across its own journey, so work appears to *start* somewhere
       * and *arrive* rather than blinking into existence at a node.
       */
      const fade = Math.sin(link.offset * Math.PI);
      dummy.scale.setScalar(0.035 * fade);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  /*
   * Pushed up and to the right, off the copy.
   *
   * Centred on the origin the field sat in the middle of the frame: half of it behind the
   * headline, where the scrim has to erase it, and a dead band across the top right where there
   * was nothing at all. Offsetting it puts the density where the page is empty and leaves the
   * copy column clear — which is also why the scrim can be lighter than it would otherwise need
   * to be.
   */
  return (
    <group ref={group} position={[1.7, 0.75, 0]}>
      <points geometry={nodeGeometry}>
        <pointsMaterial
          size={0.075}
          vertexColors
          transparent
          opacity={0.95}
          sizeAttenuation
          depthWrite={false}
        />
      </points>

      {/*
        The links, at a strength you can actually see.

        They were at 0.18 and the field read as loose dots — the structure between them, which is
        the whole idea, was only just there. The reason they were kept that faint was a fear of
        drawing a cage behind the headline, and that fear was solved a different way: the field is
        offset to the right, so the copy column sits over almost none of it and the lines can carry
        their own weight where the page is empty.

        Colour rather than thickness, because `linewidth` is ignored by every browser's WebGL
        implementation — a line is always one pixel, so opacity and hue are the only levers there
        are. Lifted towards the lighter violet as well: #8b5cf6 at low alpha over a near-black
        ground is nearly the ground.
      */}
      <lineSegments geometry={linkGeometry}>
        <lineBasicMaterial color="#a78bfa" transparent opacity={0.42} depthWrite={false} />
      </lineSegments>

      <instancedMesh ref={pulses} args={[undefined, undefined, links.length]}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial color="#c4b5fd" transparent opacity={0.9} depthWrite={false} />
      </instancedMesh>
    </group>
  );
}

export function AgentField(): React.JSX.Element {
  return (
    <Canvas
      className="hero__canvas"
      camera={{ position: [0, 0, 9.5], fov: 46 }}
      /*
       * `alpha` so the CSS gradient behind shows through, and a capped pixel ratio because this is
       * a background: rendering a field of points at 3× on a retina display costs a great deal and
       * looks identical.
       */
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      dpr={[1, 1.75]}
      aria-hidden="true"
    >
      <Field />
    </Canvas>
  );
}
