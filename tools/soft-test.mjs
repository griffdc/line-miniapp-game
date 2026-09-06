#!/usr/bin/env node
/**
 * ソフトボディ試作の検証ハーネス。
 *
 *   node tools/soft-test.mjs
 *
 * 見るのは4つ:
 *   1. 積めるか            積めないなら柔らかすぎる。ゲームが成立しない
 *   2. ずらしへの寛容さ     ★これが今回の目的。剛体は「下のゼリーの半幅」まで倒れなかった
 *   3. 物理の重さ          スマホで 60fps を守れるか（1ステップ 16.6ms の何割か）
 *   4. 潰れ具合            上に載った重さでどれだけ平たくなるか。ゼリーらしさの指標
 *
 * 「ずらしへの寛容さ」は、狙い方のモデルに依存しない唯一の指標なので、
 * これで剛体版と比較する。剛体版の値は tools/tolerance の実測で 100%（倒れない）。
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const MATTER = resolve(HERE, 'matter.min.js');

if (!existsSync(MATTER)) {
  console.error('\nMatter.js がありません:\n  curl -o tools/matter.min.js https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.20.0/matter.min.js\n');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const Matter = require(MATTER);
const { Engine, Composite, Bodies, Body, Sleeping } = Matter;

global.window = { location: { hostname: 'localhost', pathname: '/' }, Matter };
global.location = global.window.location;
new Function(readFileSync(REPO + '/js/config.js', 'utf8'))();
new Function(readFileSync(REPO + '/proto/softbody.js', 'utf8'))();
const C = global.window.APP_CONFIG.game;
const SoftJelly = global.window.SoftJelly;
SoftJelly.setMatter(Matter);

// ★ サブステップ（1フレームを細かく刻む）が必須。
// 1刻みのままだと拘束の解が収束せず、ゼリーは着地後も止まらず横へ流れ、
// そもそも積み上がらない（実測: 3個積んでも塔の高さが1個ぶんのまま）。
// 8分割で 1個の残速度 1.46 → 0.03、3個の塔 77px → 145px になった。
const SUBSTEPS = 8;
const STEP = 1000 / 60 / SUBSTEPS;
const update = engine => { for (let s = 0; s < SUBSTEPS; s++) Engine.update(engine, STEP); };
const VIEW_W = 363;               // 実機の実測値（スクリーンショットの view 幅）
const PLATE = VIEW_W * C.background.plateWidth;

/** 剛体版と質量を揃える */
const massOf = t => t.w * t.h * C.density;

function makeWorld() {
  const engine = Engine.create({ enableSleeping: true });
  engine.positionIterations = 10;
  engine.velocityIterations = 8;
  engine.constraintIterations = 4;
  engine.gravity.y = C.gravity;
  Composite.add(engine.world, Bodies.rectangle(0, C.platformThickness / 2, PLATE, C.platformThickness, {
    isStatic: true, friction: 1, frictionStatic: 1, label: 'ground'
  }));
  return engine;
}

/** 一番上のゼリーの上端 */
function towerTop(jellies) {
  let top = 0;
  for (const j of jellies) { const b = SoftJelly.bounds(j); if (b.minY < top) top = b.minY; }
  return top;
}
const fallen = jellies => jellies.some(j => SoftJelly.centroid(j).y > C.fallLimitY);

/**
 * 積む。offsetRatio を渡すと、下のゼリーの半幅に対する比で左右交互にずらす。
 * @returns {{n:number, done:boolean, ms:number, squash:number, moving:number}}
 */
function stack(opts, { count = 8, offsetRatio = 0, settle = 150 } = {}) {
  const engine = makeWorld();
  const jellies = [];
  const t = C.jellyTypes[1]; // peach 58x52
  let ms = 0, frames = 0, x = 0;

  for (let i = 0; i < count; i++) {
    let top = 0, topJ = null;
    for (const j of jellies) { const b = SoftJelly.bounds(j); if (b.minY < top) { top = b.minY; topJ = j; } }
    if (topJ && offsetRatio) x = SoftJelly.centroid(topJ).x + (i % 2 ? 1 : -1) * (t.w / 2) * offsetRatio;

    const j = SoftJelly.create(x, top - 100, t, opts, massOf(t));
    SoftJelly.add(engine.world, j);
    jellies.push(j);

    for (let k = 0; k < settle; k++) {
      const t0 = performance.now();
      update(engine);
      ms += performance.now() - t0; frames++;
    }
    if (fallen(jellies)) return { n: i, done: false, ms: ms / frames, squash: 1, moving: 0 };
  }

  // 積み終わってから3秒放置
  for (let k = 0; k < 300; k++) { const t0 = performance.now(); update(engine); ms += performance.now() - t0; frames++; }
  if (fallen(jellies)) return { n: count, done: false, ms: ms / frames, squash: 1, moving: 0, late: true };

  let moving = 0;
  for (const j of jellies) for (const p of j.parts) if (Math.hypot(p.velocity.x, p.velocity.y) > 0.05) { moving++; break; }

  return {
    n: count, done: true, ms: ms / frames,
    squash: SoftJelly.squash(jellies[0]),   // 一番下＝一番重さが載っている
    height: Math.abs(towerTop(jellies)) / C.pxPerCm,
    moving
  };
}

/** 倒れ始めるずらし幅を探す。剛体版は 100% でも倒れなかった */
function tolerance(opts) {
  for (const r of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
    if (!stack(opts, { count: 8, offsetRatio: r }).done) return r;
  }
  return null;
}

// 輪郭は 16点・半径7・squareness 6（上面が平らでないと上のゼリーが滑り落ちる）
const GEO = { points: 16, radius: 7, squareness: 6, bend: 0.4, centerMass: 0.5, damping: 0.1 };
const PRESETS = [
  ['とても柔らかい spoke .05 cross .02', { ...GEO, spoke: 0.05, cross: 0.02 }],
  ['柔らかい      spoke .15 cross .05', { ...GEO, spoke: 0.15, cross: 0.05 }],
  ['やや硬い      spoke .35 cross .15', { ...GEO, spoke: 0.35, cross: 0.15 }],
  ['硬い          spoke .70 cross .35', { ...GEO, spoke: 0.70, cross: 0.35 }]
];

console.log(`\nソフトボディ試作の検証（peach 58x52 / 輪郭16点 + 中心1点 = 1個あたり17ボディ / ${SUBSTEPS}サブステップ）\n`);
console.log('設定'.padEnd(34) + '8個積めるか   倒れ始めるずらし幅   一番下の潰れ   1ステップ   放置後に動いている数');
console.log('-'.repeat(112));

for (const [name, opts] of PRESETS) {
  const s = stack(opts, { count: 8 });
  const tol = s.done ? tolerance(opts) : null;
  console.log(
    name.padEnd(34) +
    (s.done ? '積めた' : `${s.n}個で崩壊${s.late ? '(放置中)' : ''}`).padStart(16) +
    (s.done ? (tol === null ? '100%でも倒れない' : `${(tol * 100).toFixed(0)}%`) : '-').padStart(20) +
    (s.done ? `${((1 - s.squash) * 100).toFixed(0)}%` : '-').padStart(14) +
    `${s.ms.toFixed(2)}ms`.padStart(12) +
    (s.done ? `${s.moving}/8` : '-').padStart(18)
  );
}

// 個数を増やしたときの重さ。60fps = 1フレーム 16.6ms が上限
console.log('\n物理コスト（1ステップあたり。16.6ms を超えたら 60fps を維持できない）');
console.log('ゼリー数   ボディ数   1ステップ   16.6ms に対する割合');
for (const count of [3, 8, 12, 16]) {
  const r = stack({ ...GEO, spoke: 0.35, cross: 0.15 }, { count });
  console.log(String(count).padStart(6) + String(count * 17).padStart(11) +
    `${r.ms.toFixed(2)}ms`.padStart(12) + `${(r.ms / 16.6 * 100).toFixed(0)}%`.padStart(18) +
    (r.done ? '' : `  ※${r.n}個で崩壊`));
}
console.log('\n比較: 剛体版は「100%ずらしても倒れない」「1フレーム 0.008ms」。');
