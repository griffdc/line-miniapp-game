#!/usr/bin/env node
/**
 * 「皿の端に落ちたゼリーが傾いたまま止まる」の回帰テスト。
 *
 *   node tools/tilt-test.mjs
 *
 * 原因は Matter の sleep。ゆっくり倒れかけている body は速度がほぼ 0 なので
 * 「静止」と誤認されて眠り、傾いたまま固まる。
 * config.tiltNoSleepDeg より傾いている間は眠らせない（game.js guardTiltedSleep）。
 * 結果は「水平に落ち着く」か「落ちる」のどちらかでなければならない。
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MATTER = resolve(HERE, 'matter.min.js');
if (!existsSync(MATTER)) { console.error('tools/matter.min.js がありません（stack-test.mjs 冒頭を参照）'); process.exit(1); }
const { Engine, Composite, Bodies, Sleeping } = createRequire(import.meta.url)(MATTER);

global.window = { location: { hostname: 'localhost', pathname: '/' } };
global.location = global.window.location;
new Function(readFileSync(resolve(HERE, '..', 'js/config.js'), 'utf8'))();
const C = global.window.APP_CONFIG.game;
const STEP = 1000 / 60, VIEW_W = 390;

function trial(over, type) {
  const e = Engine.create({ enableSleeping: true });
  e.positionIterations = 10; e.velocityIterations = 8; e.constraintIterations = 4;
  e.gravity.y = C.gravity;
  const pw = VIEW_W * C.background.plateWidth;
  Composite.add(e.world, Bodies.rectangle(0, C.platformThickness / 2, pw, C.platformThickness, { isStatic: true, friction: 1, frictionStatic: 1 }));
  const b = Bodies.rectangle(-pw / 2 + type.w * (0.5 - over), -160, type.w, type.h, {
    chamfer: { radius: Math.min(type.w, type.h) * C.chamferRatio },
    friction: C.friction, frictionStatic: C.frictionStatic, frictionAir: C.frictionAir,
    restitution: C.restitution, density: C.density });
  Composite.add(e.world, b);
  for (let i = 0; i < 600; i++) {
    Engine.update(e, STEP);
    const d = Math.abs(b.angle * 180 / Math.PI) % 90, t = Math.min(d, 90 - d);
    if (t > C.tiltNoSleepDeg) { b.sleepThreshold = Infinity; if (b.isSleeping) Sleeping.set(b, false); }
    else if (b.sleepThreshold !== 60) b.sleepThreshold = 60;
  }
  const d = Math.abs(b.angle * 180 / Math.PI) % 90, tilt = Math.min(d, 90 - d);
  return { fell: b.position.y > C.fallLimitY, tilt };
}

let stuck = 0, flat = 0, fell = 0; const bad = [];
for (const over of [0.30, 0.34, 0.36, 0.38, 0.40, 0.41, 0.43, 0.46]) for (const t of C.jellyTypes) {
  const r = trial(over, t);
  if (r.fell) fell++; else if (r.tilt > 12) { stuck++; bad.push(`${t.id} はみ出し${Math.round(over*100)}% 傾き${r.tilt.toFixed(0)}°`); } else flat++;
}
console.log(`tiltNoSleepDeg=${C.tiltNoSleepDeg}  試行${flat + fell + stuck}: 水平${flat} 落下${fell} 傾いたまま${stuck}`);
if (stuck) { console.log('❌ 傾いたまま固まった:\n  ' + bad.join('\n  ')); process.exit(1); }
console.log('✅ 傾いたまま止まるケースなし');
