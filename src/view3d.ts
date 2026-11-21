// The 3D race view (#147): the WebGL renderer, the scene and everything drawn in it (circuit, cars, ghost car, arrows, player
// marker). This module and Three.js are a separate chunk, loaded with a dynamic import() from src/main.ts once the title is
// up, so the first download is the title and menus only. main.ts keeps all game, camera and UI state; this only draws it.
// Nothing here changes a race: it reads the race, the poses and the camera main.ts works out.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as T from './track';
import type { Car, Race } from './race';
import type { Pose } from './timing';
import type { BayPaint } from './bays';
import { buildWorld, disposeWorld, arrowGeometry, type World } from './world';
import { Y0, disposeObject } from './gfx';
import { makeCar, makeGhostCar, makePlayerMarker, dimCar, type CarVisual } from './carModel';

/** The renderer could not be created (no WebGL): main.ts shows the readable message it showed before the split. */
export class NoWebglError extends Error {}

const MARKER_PX = 20;      // ring radius in CSS pixels once zoomed out, whatever the viewport or preset
const MARKER_MIN = 1.25;   // world units: never tighter than the car in close views
const TILT = THREE.MathUtils.degToRad(13);

/** What main.ts hands each frame for the cars and the player marker. */
export interface CarsFrame {
  race: Race;
  poses: Pose[];
  dt: number;
  time: number;
  /** index of the local driver's car in race.cars */
  meIdx: number;
  /** the local driver's car is on the lower level of a crossing */
  under: boolean;
  /** the player marker should be showing (overview views, beneath a bridge) */
  markerWanted: boolean;
  /** the view's world height (main.ts curSpan) and the box height in CSS pixels */
  span: number;
  vpH: number;
}

export class View3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly sun = new THREE.DirectionalLight(0xfff1dc, 2.1);
  world: World;
  private visuals: CarVisual[] = [];
  private readonly arrowMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
  private readonly pitArrowMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
  readonly laneArrow = new THREE.Mesh(new THREE.BufferGeometry(), this.arrowMat);
  readonly pitArrow: THREE.Mesh;
  private laneArrowKey = '';
  /**
   * The player marker: shown in overview views and, through the deck, beneath a bridge. It sits outside the car's group so
   * the tow and recovery blinks leave it steady, and it draws over everything so decks can't hide it.
   */
  readonly marker = makePlayerMarker();
  private markerFade = 0;
  private bridgeFade = 1;
  private shadowSpan = 0;
  /** the personal-best ghost's car, handed to GhostPlayer.attach */
  readonly ghostCar = makeGhostCar();

  /** Throws NoWebglError when WebGL cannot initialise. The canvas goes first in `app`, under the HUD and menus. */
  constructor(app: HTMLElement, size: { w: number; h: number }, pixelRatio: number) {
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch (err) {
      throw new NoWebglError(String(err));
    }
    const renderer = this.renderer;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(size.w, size.h, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    app.prepend(renderer.domElement);

    const scene = this.scene;
    scene.background = new THREE.Color(0x2b2420);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.3;

    this.camera = new THREE.PerspectiveCamera(38, size.w / size.h, 0.5, 600);
    scene.add(new THREE.HemisphereLight(0xe8f2ff, 0x4d6b3a, 0.7));
    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    scene.add(sun, sun.target);

    this.world = buildWorld();
    scene.add(this.world.root);

    // lane-change / pit arrows
    this.laneArrow.visible = false; this.laneArrow.renderOrder = 5; scene.add(this.laneArrow);
    this.pitArrow = new THREE.Mesh(this.pitArrowGeo(), this.pitArrowMat);
    this.pitArrow.visible = false; this.pitArrow.renderOrder = 5; scene.add(this.pitArrow);
    scene.add(this.marker);
    scene.add(this.ghostCar.group);
  }

  get canvas(): HTMLCanvasElement { return this.renderer.domElement; }

  private pitArrowGeo(): THREE.BufferGeometry {
    return arrowGeometry(T.PIT_IN0 - 3.5, T.PIT_IN1 + 1.5, (s) => (s < T.PIT_IN0 ? -T.LANE_HALF : T.pitD(s)), 0.2);
  }

  /** The circuit changed (T.setTrack): rebuild the world and the pit arrow, hide the lane arrow. */
  setTrack(): void {
    disposeWorld(this.world);
    this.world = buildWorld();
    this.scene.add(this.world.root);
    this.pitArrow.geometry.dispose();
    this.pitArrow.geometry = this.pitArrowGeo();
    this.resetArrows();
  }

  /** A new race: the lane arrow is drawn afresh for it. */
  resetArrows(): void { this.laneArrow.visible = false; this.laneArrowKey = ''; }

  /** One car model per car of `race`, the local driver's marked; the bays are painted from `bays`. */
  rebuildCars(race: Race, isMe: (c: Car) => boolean, bays: BayPaint[]): void {
    for (const v of this.visuals) { disposeObject(v.group); v.group.removeFromParent(); }
    this.visuals = race.cars.map((c) => { const v = makeCar(c.color, c.num, isMe(c)); this.scene.add(v.group); return v; });
    this.world.paintBays(bays);
  }

  /** Size the drawing buffer to the game's box and pixel ratio (preset). */
  fit(size: { w: number; h: number }, pixelRatio: number): void {
    this.camera.aspect = size.w / size.h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(size.w, size.h, false);
  }

  /** Place the camera over `target` (world x/z) showing `span` of world height; shadows follow the view. */
  placeCamera(target: { x: number; z: number }, span: number, aspect: number): void {
    const camera = this.camera;
    const dist = span / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.position.set(target.x, Math.cos(TILT) * dist, target.z + Math.sin(TILT) * dist);
    camera.lookAt(target.x, 0, target.z);
    const sh = span * Math.max(1, aspect) * 0.62 + 4;
    if (Math.abs(sh - this.shadowSpan) > this.shadowSpan * 0.08) {
      this.shadowSpan = sh;
      const c = this.sun.shadow.camera;
      c.left = -sh; c.right = sh; c.top = sh; c.bottom = -sh; c.near = 1; c.far = 160;
      c.updateProjectionMatrix();
    }
    this.sun.position.set(target.x - 22, 45, target.z + 14);
    this.sun.target.position.set(target.x, 0, target.z);
  }

  syncCars(f: CarsFrame): void {
    const { race, poses, dt, time } = f;
    race.cars.forEach((c, i) => {
      const v = this.visuals[i];
      const pose = poses[i];
      v.group.position.set(pose.x, pose.z, -pose.y);
      v.group.rotation.set(pose.roll, pose.h, pose.pitch, 'YXZ');
      // body roll from wobble / crash tumble
      if (c.mode === 'off' && c.off) {
        v.body.rotation.x = Math.sin(c.off.t * 9) * 0.25 * Math.max(0, 1 - c.off.t);
        v.body.rotation.z = Math.sin(c.off.t * 7) * 0.15 * Math.max(0, 1 - c.off.t);
      } else {
        v.body.rotation.x = c.wobble * Math.sin(time * 31 + i) * 0.12;
        v.body.rotation.z = -Math.min(0.06, c.v * 0.004) * (c.throttle - c.brake * 0.6);
      }
      for (const w of v.wheels) w.rotation.z -= (c.v * dt) / 0.12;
      const blink = c.mode === 'tow' ? Math.floor(time * 8) % 2 === 0 && c.towT < 0.9 : c.recoverT > 0 ? Math.floor(time * 12) % 2 === 0 : true;
      v.group.visible = blink;
      // held for an away driver (#74, Car.away from the server's snapshot): out of traffic, so drawn see-through on every client
      dimCar(v, c.away);
    });
    // bridge decks turn translucent while the player drives beneath them
    const target = f.under ? 0.28 : 1;
    this.bridgeFade += (target - this.bridgeFade) * Math.min(1, dt * 8);
    for (const m of this.world.bridgeMats) m.opacity = this.bridgeFade;
    const marker = this.marker;
    this.markerFade += ((f.markerWanted ? 1 : 0) - this.markerFade) * Math.min(1, dt * 8);
    marker.visible = this.markerFade > 0.02;
    if (marker.visible) {
      const mp = poses[f.meIdx];
      marker.position.set(mp.x, mp.z + Y0 + 0.05, -mp.y);
      marker.quaternion.copy(this.camera.quaternion);
      // span is the world height of the view, so this holds a constant on-screen size
      marker.scale.setScalar(Math.max(MARKER_MIN, (MARKER_PX * f.span) / f.vpH) * (1 + Math.sin(time * 3) * 0.04));
      for (const m of marker.children) ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = this.markerFade;
    }
  }

  /** The local driver's lane-change and pit arrows, own bay glow, penalty box and start lights. */
  syncArrows(race: Race, p: Car, time: number): void {
    const { laneArrow, pitArrow, arrowMat, pitArrowMat, world } = this;
    // lane change arrow: a pit route draws its choice for the next switch, straight when that means staying in lane
    const route = race.nextRoute(p);
    if (p.laneReq || p.change || route) {
      const sw = p.change ? { s0: p.change.s0, s1: p.change.s1 } : race.nextSwitch(p);
      const from = p.change ? p.change.from : Math.sign(p.laneSide) || 1;
      const to = p.change ? p.change.to : route ? route.to : -from;
      const key = `${sw.s0}:${from}:${to}`;
      if (key !== this.laneArrowKey) {
        this.laneArrowKey = key;
        laneArrow.geometry.dispose();
        const len = sw.s1 - sw.s0;
        laneArrow.geometry = arrowGeometry(sw.s0 - 2.5, sw.s1 + 1.2, (s) => T.LANE_HALF * (from + (to - from) * T.smooth((s - sw.s0) / len)), 0.16);
      }
      laneArrow.visible = true;
      arrowMat.opacity = p.change ? 0.35 : 0.55 + Math.sin(time * 8) * 0.3;
      arrowMat.color.setHex(route && !route.override ? 0x22d3ee : 0xffd23f);
    } else laneArrow.visible = false;
    pitArrow.visible = route !== null;
    pitArrowMat.opacity = 0.55 + Math.sin(time * 8) * 0.3;
    if (route) {
      // cyan when the car will reach the entrance in the outside lane: the next switch only counts if it comes first
      const s = race.s(p);
      const side = T.ahead(s, race.nextSwitch(p).s0) < T.ahead(s, T.PIT_IN0) ? route.to : p.change ? p.change.to : p.laneSide;
      pitArrowMat.color.setHex(side < 0 ? 0x22d3ee : 0xff6b6b);
    }
    // the player's own bay glows while the car is heading for it (cyan, pulsing) and while it stands in it (green); no other bay is offered
    const bound = (p.mode === 'pitlane' && p.pitFuel && !p.serviced) || ((p.mode === 'race') && p.sgCtl && p.sgOwed <= 0);
    world.bayGlow.forEach((m, j) => {
      const own = j === p.bayHome;
      const inIt = (p.mode === 'service' || p.mode === 'bayIn') && p.bay === j;
      m.color.setHex(inIt ? 0x3cff8a : 0x7dd3fc);
      m.opacity = inIt ? 0.45 : own && bound && race.bayFree(j, p) ? 0.25 + Math.sin(time * 7) * 0.15 : 0;
    });
    // penalty box: pulses red while the player owes a stop-and-go, solid while serving
    const owes = p.sgOwed > 0 && !p.finished;
    world.penGlow.opacity = !owes ? 0 : p.sgServing ? 0.5 : 0.25 + Math.sin(time * 7) * 0.15;
    world.penGlow.color.setHex(p.sgServing ? 0x3cff8a : 0xff4444);
    world.startLights.forEach((m, i) => {
      const on = race.phase === 'countdown' && i < race.lights;
      m.emissive.setHex(on ? 0xff1a1a : 0x000000);
      m.emissiveIntensity = on ? 3 : 0;
      m.color.setHex(on ? 0xff3333 : 0x330000);
    });
  }

  render(): void { this.renderer.render(this.scene, this.camera); }

  /** diagnostics (__game.info) */
  info(): { calls: number; tris: number; objects: number; frames: number; geometries: number; textures: number } {
    const i = this.renderer.info;
    return { calls: i.render.calls, tris: i.render.triangles, objects: this.world.root.children.length, frames: i.render.frame, geometries: i.memory.geometries, textures: i.memory.textures };
  }
}
