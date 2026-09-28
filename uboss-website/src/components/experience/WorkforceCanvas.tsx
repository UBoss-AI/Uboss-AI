'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { SceneProgress } from '@/lib/story';

type SceneProps = { progress: RefObject<SceneProgress>; playing: boolean; onReady: () => void; onFailure: () => void };
type MotionProps = { progress: RefObject<SceneProgress>; time: RefObject<number> };
const COLORS = ['#ba9eff', '#8dd5e5', '#b3e4d0'] as const;
const colorFor = (i: number) => COLORS[i % 3] ?? COLORS[0];
const smooth = THREE.MathUtils.smoothstep;
const POSITIONS: [number, number, number][] = [[-1.65, -.75, .05], [0, -.88, .35], [1.65, -.75, .05]];

function StudioEnvironment() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const room = new RoomEnvironment();
    const generator = new THREE.PMREMGenerator(gl);
    const target = generator.fromScene(room, 0.04);
    const previous = scene.environment;
    const oldIntensity = scene.environmentIntensity;
    scene.environment = target.texture;
    scene.environmentIntensity = .85;
    room.dispose(); generator.dispose();
    return () => { scene.environment = previous; scene.environmentIntensity = oldIntensity; target.dispose(); };
  }, [gl, scene]);
  return null;
}

function Core({ progress, time }: MotionProps) {
  const group = useRef<THREE.Group>(null);
  const sculpture = useRef<THREE.Group>(null);
  const orbit = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    const p = progress.current.value;
    const assemble = smooth(p, .29, .46);
    if (group.current) {
      const scale = 1.05 - assemble * .6;
      group.current.scale.setScalar(scale);
      group.current.position.y = .12 + assemble * 1.22 + Math.sin(time.current * .42) * .035;
    }
    if (sculpture.current) {
      sculpture.current.rotation.y = time.current * .095 + p * .55;
      sculpture.current.rotation.z = -.24 + Math.sin(time.current * .18) * .12;
      sculpture.current.rotation.x = THREE.MathUtils.damp(sculpture.current.rotation.x, .3 + smooth(p, .15, .28) * .5, 3, delta);
    }
    if (orbit.current) orbit.current.rotation.y = -.3 + time.current * .055;
  });
  return <group ref={group}>
    <UbossMark progress={progress} time={time} />
    <group ref={sculpture} rotation={[.3, 0, -.24]}>
      <mesh scale={.34}><torusKnotGeometry args={[.82, .255, 192, 24, 2, 3]} /><meshPhysicalMaterial color="#d8c7ff" metalness={.74} roughness={.19} clearcoat={1} clearcoatRoughness={.15} iridescence={.48} iridescenceIOR={1.3} envMapIntensity={1.4} /></mesh>
      <mesh scale={.14} rotation={[.7, .5, .4]}><icosahedronGeometry args={[1.1, 3]} /><meshPhysicalMaterial color="#b896ff" metalness={.35} roughness={.17} clearcoat={1} emissive="#7b42dc" emissiveIntensity={.8} /></mesh>
    </group>
    <group ref={orbit} rotation={[0, -.3, 0]}>
      <group rotation={[1.14, -.15, -.22]}>
        <mesh><torusGeometry args={[1.58, .012, 8, 120]} /><meshStandardMaterial color="#a9a2c8" metalness={.65} roughness={.2} emissive="#8e6bbd" emissiveIntensity={.55} /></mesh>
        <mesh position={[1.58, 0, 0]}><sphereGeometry args={[.045, 12, 12]} /><meshBasicMaterial color={[1.4, 1.2, 2]} toneMapped={false} /></mesh>
      </group>
      <group rotation={[.32, .8, .5]}><mesh><torusGeometry args={[1.75, .005, 6, 120, Math.PI * 1.45]} /><meshBasicMaterial color="#6fa5b7" transparent opacity={.6} /></mesh></group>
    </group>
  </group>;
}

function UbossMark({ progress, time }: MotionProps) {
  const root = useRef<THREE.Group>(null);
  const left = useMemo(() => new RoundedBoxGeometry(.38, 1.65, .28, 8, .17), []);
  const arch = useMemo(() => new THREE.TorusGeometry(.62, .19, 16, 72, Math.PI), []);
  useEffect(() => () => { left.dispose(); arch.dispose(); }, [left, arch]);
  useFrame((_, delta) => {
    if (!root.current) return;
    const p = progress.current.value;
    // Keep the U legible: a premium object can breathe without turning edge-on.
    root.current.rotation.y = Math.sin(time.current * .16) * .24 + p * .1;
    root.current.rotation.x = THREE.MathUtils.damp(root.current.rotation.x, .18 + Math.sin(time.current * .33) * .06, 2.5, delta);
    root.current.scale.setScalar(1.28 - smooth(p, .27, .47) * .26);
  });
  return <group ref={root} position={[0, .12, .06]}>
    <mesh geometry={left} position={[-.61, .34, 0]}><meshPhysicalMaterial color="#ede8ff" metalness={.82} roughness={.14} clearcoat={1} iridescence={.35} envMapIntensity={1.6} /></mesh>
    <mesh geometry={left} position={[.61, .34, 0]}><meshPhysicalMaterial color="#c9b9ff" metalness={.78} roughness={.16} clearcoat={1} iridescence={.45} envMapIntensity={1.6} /></mesh>
    <mesh geometry={arch} position={[0, -.44, 0]} rotation={[0, 0, Math.PI]}><meshPhysicalMaterial color="#d5c6ff" metalness={.8} roughness={.14} clearcoat={1} iridescence={.4} envMapIntensity={1.6} /></mesh>
    <pointLight position={[0, -.15, .65]} intensity={5} distance={3.5} color="#b894ff" />
  </group>;
}

function Objective({ progress, time }: MotionProps) {
  const group = useRef<THREE.Group>(null);
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#111522'; ctx.fillRect(0, 0, 640, 360);
      ctx.strokeStyle = '#b9a7e7'; ctx.globalAlpha = .55; ctx.lineWidth = 3; ctx.strokeRect(13, 13, 614, 334);
      ctx.globalAlpha = 1; ctx.fillStyle = '#a9a3bb'; ctx.font = '20px Arial'; ctx.fillText('OBJECTIVE  /  OPS—017', 58, 74);
      ctx.fillStyle = '#f0ecf8'; ctx.font = '500 36px Arial'; ctx.fillText('REDUCE SERVICE', 58, 149); ctx.fillText('RESPONSE TIME', 58, 195);
      ctx.fillStyle = '#92e3c1'; ctx.fillRect(58, 252, 175, 6); ctx.fillStyle = '#9da0ae'; ctx.font = '19px Arial'; ctx.fillText('workforce plan created', 58, 303);
    }
    const result = new THREE.CanvasTexture(canvas); result.colorSpace = THREE.SRGBColorSpace; return result;
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);
  useFrame(() => {
    if (!group.current) return;
    const p = progress.current.value;
    const reveal = smooth(p, .04, .15) * (1 - smooth(p, .32, .44));
    group.current.visible = reveal > .002;
    group.current.position.set(-.15, .12, THREE.MathUtils.lerp(-2.8, -.1, reveal));
    group.current.scale.setScalar(.72 + reveal * .28);
    group.current.rotation.y = Math.sin(time.current * .3) * .04;
  });
  return <group ref={group} visible={false}><mesh><planeGeometry args={[2.55, 1.43]} /><meshBasicMaterial map={texture} toneMapped={false} transparent /></mesh></group>;
}

function HumanReview({ progress, time }: MotionProps) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!group.current) return;
    const p = progress.current.value;
    const reveal = smooth(p, .82, .93) * (1 - smooth(p, .97, 1));
    group.current.visible = reveal > .002;
    group.current.position.set(0, -1.5 + reveal * .15, .15);
    group.current.scale.setScalar(reveal);
    group.current.rotation.y = Math.sin(time.current * .5) * .08;
  });
  return <group ref={group} visible={false}>
    <mesh position={[0, .28, 0]}><sphereGeometry args={[.18, 20, 20]} /><meshPhysicalMaterial color="#e6deff" metalness={.6} roughness={.2} clearcoat={1} /></mesh>
    <mesh position={[0, -.12, 0]}><capsuleGeometry args={[.18, .45, 8, 16]} /><meshPhysicalMaterial color="#91d8c0" metalness={.55} roughness={.2} clearcoat={1} /></mesh>
    <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[.54, .025, 10, 60]} /><meshBasicMaterial color="#9ff0c7" transparent opacity={.9} /></mesh>
    <pointLight color="#86edbb" intensity={3} distance={3} />
  </group>;
}

function Agent({ index, progress, time }: MotionProps & { index: number }) {
  const group = useRef<THREE.Group>(null);
  const crystal = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!group.current || !crystal.current) return;
    const reveal = smooth(progress.current.value, .29 + index * .012, .43 + index * .012);
    const pos = POSITIONS[index]!;
    group.current.visible = reveal > .001;
    group.current.scale.setScalar(.36 + reveal * .64);
    group.current.position.set(pos[0] * reveal, pos[1] + .3 - (1 - reveal) * .8 + Math.sin(time.current * .55 + index) * .08, pos[2] - (1 - reveal) * 1.4);
    group.current.rotation.set(.15 * index, time.current * .08 + index * 2.1, (index - 1) * .12);
    crystal.current.rotation.set(time.current * .28 + index, time.current * .18, .2);
  });
  return <group ref={group} visible={false}>
    <mesh scale={[.72, 1.16, .72]}><icosahedronGeometry args={[.68, 2]} /><meshPhysicalMaterial color="#151925" metalness={.75} roughness={.12} clearcoat={1} envMapIntensity={1.55} /></mesh>
    <mesh scale={[.82, 1.3, .82]}><icosahedronGeometry args={[.68, 1]} /><meshBasicMaterial color={colorFor(index)} transparent opacity={.17} /></mesh>
    <group ref={crystal}>
      <mesh><octahedronGeometry args={[.27, 1]} /><meshPhysicalMaterial color={colorFor(index)} metalness={.75} roughness={.14} clearcoat={1} emissive={colorFor(index)} emissiveIntensity={.22} /></mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[.48, .018, 8, 60]} /><meshBasicMaterial color={colorFor(index)} transparent opacity={.85} /></mesh>
    </group>
  </group>;
}

function Skill({ index, progress, time }: MotionProps & { index: number }) {
  const mesh = useRef<THREE.Mesh>(null);
  const geometry = useMemo(() => new RoundedBoxGeometry(.2, .2, .2, 2, .04), []);
  useFrame(() => {
    if (!mesh.current) return;
    const p = progress.current.value;
    const reveal = smooth(p, .53, .65);
    const attach = smooth(p, .68, .79);
    const target = POSITIONS[index % 3]!;
    const a = index / 6 * Math.PI * 2 + time.current * .1 * (1 - attach);
    const x = Math.cos(a) * 2.2;
    const y = 1 + Math.sin(a) * .7;
    mesh.current.position.set(THREE.MathUtils.lerp(x, target[0] + (index < 3 ? -.34 : .34), attach), THREE.MathUtils.lerp(y, target[1] + .88, attach), THREE.MathUtils.lerp(-.1, target[2] + .13, attach));
    mesh.current.scale.setScalar(reveal);
    mesh.current.rotation.set(.4, time.current * .3 + index, .25);
  });
  return <mesh ref={mesh} geometry={geometry} scale={0}><meshPhysicalMaterial color={colorFor(index)} metalness={.6} roughness={.18} clearcoat={1} emissive={colorFor(index)} emissiveIntensity={.23} /></mesh>;
}

function Network({ progress }: { progress: RefObject<SceneProgress> }) {
  const group = useRef<THREE.Group>(null);
  const signal = useRef<THREE.Mesh>(null);
  const gate = useRef<THREE.MeshBasicMaterial>(null);
  const path = useMemo(() => {
    const points: THREE.Vector3[] = [];
    POSITIONS.forEach(([x, y, z]) => {
      points.push(new THREE.Vector3(0, 1.3, -.3), new THREE.Vector3(x, y + .75, z - .12));
      points.push(new THREE.Vector3(x, y - .8, z - .1), new THREE.Vector3(0, -2.12, .1));
    });
    return new THREE.BufferGeometry().setFromPoints(points);
  }, []);
  const amber = useMemo(() => new THREE.Color('#dfb883'), []);
  const green = useMemo(() => new THREE.Color('#a3e4c6'), []);
  useFrame(() => {
    if (!group.current || !signal.current || !gate.current) return;
    const p = progress.current.value;
    group.current.visible = p > .76;
    const travel = smooth(p, .77, .88);
    signal.current.position.set(0, THREE.MathUtils.lerp(.1, -2.12, travel), .45);
    gate.current.color.copy(amber).lerp(green, smooth(p, .94, .99));
  });
  return <group ref={group} visible={false}>
    <lineSegments geometry={path}><lineBasicMaterial color="#aba1c5" transparent opacity={.35} /></lineSegments>
    <mesh ref={signal}><sphereGeometry args={[.045, 12, 12]} /><meshBasicMaterial color="#e3d5ff" /></mesh>
    <mesh position={[0, -2.12, .12]}><torusGeometry args={[.16, .018, 8, 32]} /><meshBasicMaterial ref={gate} color="#dfb883" /></mesh>
  </group>;
}

function Particles() {
  const positions = useMemo(() => {
    const result = new Float32Array(54 * 3);
    for (let i = 0; i < 54; i++) { result[i * 3] = Math.sin(i * 12.2) * 3.6; result[i * 3 + 1] = Math.cos(i * 7.8) * 2.8; result[i * 3 + 2] = -1.4 - i % 4; }
    return result;
  }, []);
  return <points><bufferGeometry><bufferAttribute attach="attributes-position" args={[positions, 3]} /></bufferGeometry><pointsMaterial color="#b9a9da" size={.014} transparent opacity={.55} sizeAttenuation depthWrite={false} /></points>;
}

function Scene({ progress, playing, onReady, onFailure }: SceneProps) {
  const root = useRef<THREE.Group>(null);
  const time = useRef(0);
  const { gl, camera, size } = useThree();
  const callbacks = useRef({ onReady, onFailure });
  useEffect(() => { callbacks.current = { onReady, onFailure }; }, [onReady, onFailure]);
  useEffect(() => {
    callbacks.current.onReady();
    const lost = () => callbacks.current.onFailure();
    const restored = () => callbacks.current.onReady();
    gl.domElement.addEventListener('webglcontextlost', lost);
    gl.domElement.addEventListener('webglcontextrestored', restored);
    return () => { gl.domElement.removeEventListener('webglcontextlost', lost); gl.domElement.removeEventListener('webglcontextrestored', restored); };
  }, [gl]);
  useFrame(({ pointer }, delta) => {
    const dt = Math.min(delta, .05);
    if (playing) time.current += dt;
    if (root.current) {
      root.current.rotation.y = THREE.MathUtils.damp(root.current.rotation.y, playing ? pointer.x * .075 : 0, 4, dt);
      root.current.rotation.x = THREE.MathUtils.damp(root.current.rotation.x, playing ? -pointer.y * .035 : 0, 4, dt);
    }
    // Fit the entire composition to the actual canvas aspect; nothing hides behind HTML.
    const aspect = size.width / Math.max(1, size.height);
    const fitted = Math.max(7.6, 7.6 / aspect);
    camera.position.z = THREE.MathUtils.damp(camera.position.z, fitted + smooth(progress.current.value, .28, .45) * .5, 4, dt);
  });
  return <>
    <StudioEnvironment />
    <ambientLight intensity={.3} />
    <directionalLight position={[-3, 5, 5]} intensity={2.8} color="#e5d9ff" />
    <pointLight position={[3, 1, 3]} intensity={15} color="#9ccdf3" />
    <pointLight position={[-2, -1, 2]} intensity={10} color="#b392ff" />
    <group ref={root}>
      <Core progress={progress} time={time} />
      <Objective progress={progress} time={time} />
      {[0, 1, 2].map((index) => <Agent key={index} index={index} progress={progress} time={time} />)}
      {[0, 1, 2, 3, 4, 5].map((index) => <Skill key={index} index={index} progress={progress} time={time} />)}
      <Network progress={progress} />
      <HumanReview progress={progress} time={time} />
      <Particles />
    </group>
    <EffectComposer multisampling={0}><Bloom mipmapBlur intensity={.38} luminanceThreshold={1} luminanceSmoothing={.3} /></EffectComposer>
  </>;
}

export default function WorkforceCanvas(props: SceneProps) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false));
    if (wrapper.current) observer.observe(wrapper.current);
    const visibility = () => setTabVisible(!document.hidden);
    document.addEventListener('visibilitychange', visibility);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  return <div ref={wrapper} className="workforce-canvas"><Canvas camera={{ position: [0, 0, 7.8], fov: 40 }} dpr={[1, 1.5]} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }} frameloop={visible && tabVisible ? 'always' : 'never'} fallback={null}><Scene {...props} /></Canvas></div>;
}
