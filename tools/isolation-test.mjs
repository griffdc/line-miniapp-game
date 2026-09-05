/**
 * 揺れの伝播が「接触しているゼリー」だけに届くことを確認する回帰テスト。
 *
 *   node tools/isolation-test.mjs
 *
 * 左端に1つめ、右端に2つめを置く。触れていないので1つめは動いてはいけない。
 *
 * かつて距離と高さだけで伝播を判定していたため、
 * 無関係なゼリーが押し出されて転げ落ちる不具合があった。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { Engine, Composite, Bodies, Body, Events, Sleeping } = require(resolve(HERE, 'matter.min.js'));

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
global.window = { location: { hostname: 'localhost', pathname: '/', search: '', protocol: 'https:' } };
global.location = global.window.location;
new Function(readFileSync(REPO + '/js/config.js', 'utf8'))();
const C = global.window.APP_CONFIG.game;

const STEP = 1000 / 60, VIEW_W = 390;

function makeWorld(shakeOn = true, S = C.shake) {
  const engine = Engine.create({ enableSleeping: true });
  engine.positionIterations = 10; engine.velocityIterations = 8; engine.constraintIterations = 4;
  engine.gravity.y = C.gravity;

  const pw = VIEW_W * C.background.plateWidth; // 台の幅は背景の皿に合わせている
  Composite.add(engine.world, Bodies.rectangle(0, C.platformThickness / 2, pw, C.platformThickness, {
    isStatic: true, friction: 1, frictionStatic: 1, label: 'ground'
  }));

  const bodies = [];
  const contactGraph = () => {
    const g = {};
    for (const p of engine.pairs.list) {
      if (!p.isActive) continue;
      const a = p.bodyA, b = p.bodyB;
      if (a.label !== 'jelly' || b.label !== 'jelly') continue;
      (g[a.id] || (g[a.id] = [])).push(b);
      (g[b.id] || (g[b.id] = [])).push(a);
    }
    return g;
  };

  Events.on(engine, 'collisionStart', ev => {
    if (!shakeOn || S.scale <= 0) return;
    const graph = contactGraph();
    for (const pair of ev.pairs) {
      const sup = pair.collision && pair.collision.supports;
      if (!sup || !sup.length) continue;
      const pt = sup[0];
      const strength = Math.hypot(pair.bodyA.velocity.x - pair.bodyB.velocity.x,
                                  pair.bodyA.velocity.y - pair.bodyB.velocity.y);
      if (strength < S.minStrength) continue;
      const hops = {}, queue = [];
      for (const b of [pair.bodyA, pair.bodyB]) if (b.label === 'jelly') { hops[b.id] = 0; queue.push(b); }
      for (let head = 0; head < queue.length; head++) {
        const cur = queue[head], hop = hops[cur.id];
        if (hop >= S.maxHops) continue;
        for (const nb of (graph[cur.id] || [])) {
          if (hops[nb.id] !== undefined) continue;
          hops[nb.id] = hop + 1; queue.push(nb);
          if (nb.position.y >= pt.y) continue;
          const fade = Math.pow(S.hopDecay, hop + 1);
          const dir = nb.position.x >= pt.x ? 1 : -1;
          Sleeping.set(nb, false);
          Body.setVelocity(nb, { x: nb.velocity.x + dir * strength * S.scale * fade, y: nb.velocity.y });
        }
      }
    }
  });

  const drop = (t, x, y) => {
    const b = Bodies.rectangle(x, y, t.w, t.h, {
      chamfer: { radius: Math.min(t.w, t.h) * C.chamferRatio },
      label: 'jelly', friction: C.friction, frictionStatic: C.frictionStatic,
      frictionAir: C.frictionAir, restitution: C.restitution, density: C.density
    });
    Composite.add(engine.world, b); bodies.push(b); return b;
  };
  const step = n => { for (let i = 0; i < n; i++) { Engine.update(engine, STEP);
    const lim = C.tiltNoSleepDeg; if (lim) for (const b of bodies) { const d = Math.abs(b.angle * 180 / Math.PI) % 90, t = Math.min(d, 90 - d);
      if (t > lim) { b.sleepThreshold = Infinity; if (b.isSleeping) Sleeping.set(b, false); } else if (b.sleepThreshold !== 60) b.sleepThreshold = 60; } } };
  return { engine, bodies, drop, step, platformHalf: pw / 2 };
}

// ---------------------------------------------------------------- 回帰テスト
let FAILED = false;
console.log('=== 回帰テスト: 離れたゼリーに影響しないこと ===\n');
{
  const w = makeWorld();
  const t = C.jellyTypes[1]; // 58x52
  const edge = w.platformHalf - t.w / 2 - 2;

  const first = w.drop(t, -edge, -200);   // 左端
  w.step(180);
  const restX = first.position.x, restY = first.position.y;
  console.log(`1つめ 着地位置  x=${restX.toFixed(1)}  y=${restY.toFixed(1)}`);

  w.drop(t, edge, -200);                  // 右端。触れていない
  w.step(180);
  const dx = Math.abs(first.position.x - restX);
  const dy = Math.abs(first.position.y - restY);
  const fell = first.position.y > C.fallLimitY;

  console.log(`2つめ 落下後    1つめの移動 x=${dx.toFixed(2)}px  y=${dy.toFixed(2)}px`);
  console.log(`1つめは落下したか: ${fell ? '❌ 落下した（バグ再発）' : '✅ 落ちていない'}`);
  const ok = dx < 2 && !fell;
  console.log(ok ? '✅ ほぼ動いていない\n' : `❌ ${dx.toFixed(1)}px 動いた\n`);
  if (!ok) FAILED = true;
}

process.exit(FAILED ? 1 : 0);
