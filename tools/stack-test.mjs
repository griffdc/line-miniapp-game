#!/usr/bin/env node
/**
 * 積載安定性の検証ハーネス。ブラウザを使わずに js/config.js の値で塔を積む。
 *
 *   node tools/stack-test.mjs
 *
 * config.js を直接読むので、ゲーム本体と数値が乖離しない。
 * 物理パラメータを触ったら必ずこれを通すこと。
 *
 * 判定の考え方:
 *   失敗は「地面より fallLimitY だけ下に落ちた」のみで判定する。
 *   角度で判定してはいけない。正常に転倒した物体の角度は増え続けるので、
 *   ソルバーの破綻と区別がつかなくなる。
 *
 *   ソルバーの健全性は「⓪ 揺れ無し」で見る。
 *   同一サイズをブレなしで真ん中に積み、着地の揺れも切った状態は
 *   物理的に絶対倒れない。ここで落ちたらソルバーがエネルギーを注入している。
 *
 *   ① 以降は揺れ込みの実際の難易度。ここで崩れるのは設計どおりで、異常ではない。
 *
 *   狙いのモデルは「常に土台の中心へ落とす」。
 *   最上段を追いかけるモデルにすると自己補正が効いてしまい、実プレイより甘くなる。
 *
 * 初回のみ Matter.js の取得が必要:
 *   curl -o tools/matter.min.js https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.20.0/matter.min.js
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const MATTER = resolve(HERE, 'matter.min.js');

if (!existsSync(MATTER)) {
  console.error(
    '\nMatter.js がありません。取得してください:\n' +
    '  curl -o tools/matter.min.js https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.20.0/matter.min.js\n'
  );
  process.exit(1);
}

const require = createRequire(import.meta.url);
const { Engine, Composite, Bodies, Body, Events, Sleeping } = require(MATTER);

// 実際の config.js をそのまま読み込む
global.window = { location: { hostname: 'localhost', pathname: '/' } };
global.location = global.window.location;
new Function(readFileSync(REPO + '/js/config.js', 'utf8'))();
const C = global.window.APP_CONFIG.game;

const STEP = 1000 / 60;
const VIEW_W = 390;        // iPhone 相当
const DROPS = 60;
const SETTLE = 100;        // 1個落とすごとに回すフレーム数
const SEEDS = 8;

const rng = s => () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;

function run(types, aimError, seed, shakeOn = true) {
  const rand = rng(seed);
  const engine = Engine.create({ enableSleeping: true });
  engine.positionIterations = 10;
  engine.velocityIterations = 8;
  engine.constraintIterations = 4;
  engine.gravity.y = C.gravity;

  const pw = VIEW_W * C.background.plateWidth; // 台の幅は背景の皿に合わせている
  Composite.add(engine.world, Bodies.rectangle(0, C.platformThickness / 2, pw, C.platformThickness, {
    isStatic: true, friction: 1, frictionStatic: 1, label: 'ground'
  }));

  const bodies = [];
  let stepMs = 0, stepCount = 0;

  // game.js の applyWobble と同じ「揺れの伝播」。
  // これが難易度に効くので、ハーネスにも入れておかないと実際と乖離する。
  const S = C.shake;

  // game.js の contactGraph + applyWobble と同じ伝播。
  // 接触をたどって繋がっているゼリーにだけ伝える。距離で判定してはいけない。
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
    if (!shakeOn || !S || S.scale <= 0) return;
    const graph = contactGraph();
    for (const pair of ev.pairs) {
      const sup = pair.collision && pair.collision.supports;
      if (!sup || !sup.length) continue;
      const pt = sup[0];
      const strength = Math.hypot(pair.bodyA.velocity.x - pair.bodyB.velocity.x,
                                  pair.bodyA.velocity.y - pair.bodyB.velocity.y);
      if (strength < S.minStrength) continue;

      const hops = {}, queue = [];
      for (const b of [pair.bodyA, pair.bodyB]) {
        if (b.label === 'jelly') { hops[b.id] = 0; queue.push(b); }
      }
      for (let head = 0; head < queue.length; head++) {
        const cur = queue[head];
        const hop = hops[cur.id];
        if (hop >= S.maxHops) continue;
        for (const nb of (graph[cur.id] || [])) {
          if (hops[nb.id] !== undefined) continue;
          hops[nb.id] = hop + 1;
          queue.push(nb);
          if (nb.position.y >= pt.y) continue;
          const fade = Math.pow(S.hopDecay, hop + 1);
          const dir = nb.position.x >= pt.x ? 1 : -1;
          Sleeping.set(nb, false);
          Body.setVelocity(nb, { x: nb.velocity.x + dir * strength * S.scale * fade, y: nb.velocity.y });
        }
      }
    }
  });

  for (let d = 0; d < DROPS; d++) {
    const t = types[Math.floor(rand() * types.length)];
    let top = 0;
    for (const b of bodies) if (b.bounds.min.y < top) top = b.bounds.min.y;

    // プレイヤーは常に土台の中心を狙う、の近似
    const x = (rand() * 2 - 1) * aimError;

    const body = Bodies.rectangle(x, top - 110, t.w, t.h, {
      chamfer: { radius: Math.min(t.w, t.h) * C.chamferRatio },
      label: 'jelly',
      friction: C.friction,
      frictionStatic: C.frictionStatic,
      frictionAir: C.frictionAir,
      restitution: C.restitution,
      density: C.density
    });
    Composite.add(engine.world, body);
    bodies.push(body);

    for (let i = 0; i < SETTLE; i++) {
      const t0 = performance.now();
      Engine.update(engine, STEP);
      stepMs += performance.now() - t0;
      stepCount++;
    }
    for (const b of bodies) if (b.position.y > C.fallLimitY) return { n: d + 1, done: false };
  }

  // 積み終わってから5秒放置しても崩れないか
  for (let i = 0; i < 300; i++) Engine.update(engine, STEP);
  for (const b of bodies) if (b.position.y > C.fallLimitY) return { n: DROPS, done: false };

  let top = 0, sleeping = 0;
  for (const b of bodies) {
    if (b.bounds.min.y < top) top = b.bounds.min.y;
    if (b.isSleeping) sleeping++;
  }
  return {
    n: DROPS, done: true,
    h: Math.round(-top / C.pxPerCm),
    sleep: `${sleeping}/${bodies.length}`,
    stepMs: +(stepMs / stepCount).toFixed(3)
  };
}

const UNIFORM = [{ w: 58, h: 46 }];
const CASES = [
  ['⓪ 揺れ無し・ブレ0px（破綻検出）', UNIFORM, 0, false],
  ['① 同一サイズ・ブレ0px', UNIFORM, 0],
  ['② 5種類・ブレ6px（上手い）', C.jellyTypes, 6],
  ['③ 5種類・ブレ12px（普通）', C.jellyTypes, 12],
  ['④ 5種類・ブレ20px（下手）', C.jellyTypes, 20]
];

console.log('\n物理設定 (js/config.js):');
console.log(`  gravity=${C.gravity}  chamferRatio=${C.chamferRatio}  friction=${C.friction}` +
            `  frictionAir=${C.frictionAir}  restitution=${C.restitution}\n`);
console.log(`${DROPS}個まで積む / ${SEEDS}シードの平均\n`);
console.log('シナリオ                         結果        完走     高さ    sleep    物理コスト');
console.log('-'.repeat(84));

let sanityOk = false;
for (const [label, types, aim, shakeOn = true] of CASES) {
  let sum = 0, done = 0, hs = [], sleep = '-', ms = 0;
  for (let s = 1; s <= SEEDS; s++) {
    const r = run(types, aim, s * 7919, shakeOn);
    sum += r.n;
    if (r.done) { done++; hs.push(r.h); sleep = r.sleep; ms = r.stepMs; }
  }
  if (label.startsWith('⓪')) sanityOk = done === SEEDS;
  const avg = (sum / SEEDS).toFixed(1);
  console.log(
    label.padEnd(32) +
    (done === SEEDS ? `${DROPS}個完走` : `${avg}個`).padStart(9) +
    `${done}/${SEEDS}`.padStart(9) +
    (hs.length ? `${Math.round(hs.reduce((a, b) => a + b) / hs.length)}cm` : '-').padStart(8) +
    String(sleep).padStart(9) +
    (ms ? `${ms}ms` : '-').padStart(12)
  );
}

console.log('');
if (sanityOk) {
  console.log('✅ ⓪が完走。ソルバーは破綻していない。');
  console.log('   ①以降で崩れるのは設計どおりの脆さ（shake.scale で調整）。');
} else {
  console.log('❌ ⓪が落ちた。物理設定が壊れている。');
  console.log('   gravity を下げる（1.2→0.6 で解決した実績あり）か、chamferRatio を下げる。');
  console.log('   反復回数を増やしても効果がないことは実測済み。');
}
console.log('');
