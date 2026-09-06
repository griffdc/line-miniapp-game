/**
 * ソフトボディゼリーの試作。
 *
 * 目的:
 *   剛体では「重心が下の接触面の端を越えるまで倒れない」という幾何学的な限界があり、
 *   積載の寛容さをこれ以上下げられないことが実測で分かった（摩擦・回転・形状すべて無効）。
 *   接触そのものを柔らかくするには、変形する物体で積むしかない。
 *
 * 方式:
 *   ゼリー1個を「輪郭に並べた円 + 中心の円」で作り、拘束でつなぐ。
 *   衝突・摩擦・眠りは Matter に任せ、柔らかさは拘束の硬さで作る。
 *   自前で PBD を書く手もあるが、そちらは衝突判定も自作になる。
 *   まずは Matter に載る範囲で成立するかを見る。
 *
 *   - 輪郭の隣同士をつなぐ拘束 = 表面の伸び縮み（edge）
 *   - 輪郭から中心へ伸びる拘束 = 潰れへの抵抗（spoke）
 *   - 向かい合う輪郭同士をつなぐ拘束 = 平たく潰れることへの抵抗（cross）
 *
 *   同じゼリーの部品同士は衝突させない（負の group を使う）。
 *   部品は重なって配置するので、衝突させると内部で反発して破裂する。
 *
 * ブラウザからも Node からも読めるように、依存は Matter だけにしてある。
 * Node からは new Function で読み込み、Matter を setMatter() で渡す。
 */
(function (root) {
  'use strict';

  var M = root.Matter || null;

  /** 既定のパラメータ。ここを触って手触りを作る。 */
  var DEFAULTS = {
    points: 12,        // 輪郭に並べる円の数。増やすと滑らかで漏れにくいが重い
    radius: 9,         // 円の半径。隣同士が重なる大きさが必要（隙間から相手が入る）
    squareness: 3.2,   // 2=楕円 4=角丸長方形に近い。ゼリーらしさと接地面の広さに効く
    edge: 0.9,         // 表面の硬さ。低いと伸びて垂れる
    bend: 0.4,         // ひとつ飛ばしの点をつなぐ。輪郭の「曲がりにくさ」＝形状記憶。
                       //   これが無いと荷重で少しずつ形が流れ、塔が沈み続けて崩れる
    spoke: 0.05,       // 中心へのバネ。低いほど柔らかく潰れる ★ここが「ぷるぷる」の主役
    cross: 0.03,       // 向かい合う点同士。低いと平たく潰れる
    centerMass: 0.5,   // 全体の質量のうち中心の円が持つ割合。
                       //   中心に寄せるほど「柔らかい皮をかぶった重り」になり塔が安定する。
                       //   0 にすると質量が輪郭に散り、ブロブ全体が流れやすくなる
    damping: 0.1,      // 拘束の減衰。低いと揺れが止まらない
    friction: 0.9,
    frictionStatic: 1.0,
    frictionAir: 0.03,
    restitution: 0,
    slop: 0.05,

    // アリーナ（土台と壁）の既定値
    platformThickness: 24,
    wallHeight: 80,    // 壁の高さ(px)。10px = 1cm。これを越えると支えが無くなる
    wallThickness: 10
  };

  /** 超楕円。squareness=2 で楕円、大きくすると角丸長方形に近づく */
  function superEllipse(a, hw, hh, k) {
    var c = Math.cos(a), s = Math.sin(a);
    var e = 2 / k;
    return {
      x: (c < 0 ? -1 : 1) * Math.pow(Math.abs(c), e) * hw,
      y: (s < 0 ? -1 : 1) * Math.pow(Math.abs(s), e) * hh
    };
  }

  var groupSeq = 0;

  /**
   * ゼリー1個を作る。
   * @param {number} x,y   中心のワールド座標
   * @param {{w:number,h:number,color:string}} type
   * @param {object} opts  DEFAULTS を上書きする値
   * @param {number} targetMass ゼリー全体の質量（剛体版と揃えるため）
   * @returns {{parts:Array, center:object, ring:Array, constraints:Array, type:object}}
   */
  function create(x, y, type, opts, targetMass) {
    var P = Object.assign({}, DEFAULTS, opts || {});
    var Bodies = M.Bodies, Body = M.Body, Constraint = M.Constraint;

    var n = P.points, r = P.radius;
    // 円の半径ぶん内側に輪郭を作る。こうすると円の外周が見た目の輪郭に一致する
    var hw = Math.max(r * 0.6, type.w / 2 - r);
    var hh = Math.max(r * 0.6, type.h / 2 - r);

    // 同じゼリーの部品同士は衝突させない
    groupSeq -= 1;
    var group = groupSeq;

    var common = {
      collisionFilter: { group: group },
      friction: P.friction,
      frictionStatic: P.frictionStatic,
      frictionAir: P.frictionAir,
      restitution: P.restitution,
      slop: P.slop,
      label: 'jellyPart'
    };

    var ring = [], i;
    for (i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2 - Math.PI / 2;
      var p = superEllipse(a, hw, hh, P.squareness);
      ring.push(Bodies.circle(x + p.x, y + p.y, r, Object.assign({}, common)));
    }
    var center = Bodies.circle(x, y, r * 0.9, Object.assign({}, common));

    var parts = ring.concat([center]);

    // 質量を剛体版に合わせる。合わせないと落下も衝撃も別物になり比較できない。
    // centerMass の割合だけ中心の円に持たせ、残りを輪郭で等分する。
    if (targetMass) {
      var cm = Math.max(0, Math.min(0.95, P.centerMass));
      Body.setMass(center, Math.max(0.0001, targetMass * cm));
      var each = Math.max(0.0001, targetMass * (1 - cm) / n);
      for (i = 0; i < n; i++) Body.setMass(ring[i], each);
    }

    var cons = [];
    function link(a, b, stiffness) {
      var dx = b.position.x - a.position.x, dy = b.position.y - a.position.y;
      cons.push(Constraint.create({
        bodyA: a, bodyB: b,
        length: Math.sqrt(dx * dx + dy * dy),
        stiffness: stiffness,
        damping: P.damping,
        render: { visible: false }
      }));
    }

    for (i = 0; i < n; i++) {
      link(ring[i], ring[(i + 1) % n], P.edge);   // 表面
      link(ring[i], center, P.spoke);             // 中心へ
      if (P.bend > 0) link(ring[i], ring[(i + 2) % n], P.bend); // ひとつ飛ばし＝曲がりにくさ
      if (P.cross > 0 && i < n / 2) link(ring[i], ring[(i + (n >> 1)) % n], P.cross); // 差し渡し
    }

    var jelly = {
      type: type, parts: parts, ring: ring, center: center,
      constraints: cons, group: group, radius: r,
      landed: false
    };
    // 部品からゼリー本体を引けるようにする（衝突イベントで使う）
    for (i = 0; i < parts.length; i++) parts[i].jelly = jelly;
    return jelly;
  }

  /**
   * 土台と、その両端の壁を作る。
   *
   * 柔らかいゼリーは潰れて横へ広がるので、壁が無いと塔にならず山になる
   * （実測: 8個積んでも高さは3個ぶん）。壁で横を止めると、潰れる力が上へ向く。
   *
   * 壁は一定の高さまでしかない。越えた分は支えが無くなり、ずれれば落ちる。
   * ここがゲームの難易度になる。
   *
   * @param {number} plateW 土台の幅
   * @param {number} wallH  壁の高さ(px)。0 で壁なし
   * @param {number} wallT  壁の厚み(px)
   * @returns {{ground:object, walls:Array, all:Array}}
   */
  function arena(plateW, wallH, wallT) {
    var Bodies = M.Bodies;
    var th = DEFAULTS.platformThickness;
    wallH = wallH === undefined ? DEFAULTS.wallHeight : wallH;
    wallT = wallT || DEFAULTS.wallThickness;
    var opt = { isStatic: true, friction: 1, frictionStatic: 1 };
    var ground = Bodies.rectangle(0, th / 2, plateW, th, Object.assign({ label: 'ground' }, opt));
    var walls = [];
    if (wallH > 0) {
      // 土台の内側の端に立てる。外側だと実質的に皿が広くなってしまう
      var x = plateW / 2 - wallT / 2;
      walls.push(Bodies.rectangle(-x, -wallH / 2, wallT, wallH, Object.assign({ label: 'wall' }, opt)));
      walls.push(Bodies.rectangle(x, -wallH / 2, wallT, wallH, Object.assign({ label: 'wall' }, opt)));
    }
    return { ground: ground, walls: walls, all: [ground].concat(walls) };
  }

  /** ワールドに追加する */
  function add(world, jelly) {
    M.Composite.add(world, jelly.parts.concat(jelly.constraints));
  }

  /** 見た目の輪郭。輪郭の円を半径ぶん外へ押し出した点列を返す */
  function outline(jelly) {
    var pts = [], ring = jelly.ring, n = ring.length;
    var cx = 0, cy = 0, i;
    for (i = 0; i < n; i++) { cx += ring[i].position.x; cy += ring[i].position.y; }
    cx /= n; cy /= n;
    for (i = 0; i < n; i++) {
      var dx = ring[i].position.x - cx, dy = ring[i].position.y - cy;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      pts.push({ x: ring[i].position.x + dx / d * jelly.radius, y: ring[i].position.y + dy / d * jelly.radius });
    }
    return pts;
  }

  /** 中心位置（重心）。高さ計測や落下判定に使う */
  function centroid(jelly) {
    var x = 0, y = 0, p = jelly.parts;
    for (var i = 0; i < p.length; i++) { x += p[i].position.x; y += p[i].position.y; }
    return { x: x / p.length, y: y / p.length };
  }

  /** 外接矩形。高さ（塔の先端）に使う */
  function bounds(jelly) {
    var L = Infinity, R = -Infinity, T = Infinity, B = -Infinity, p = jelly.parts;
    for (var i = 0; i < p.length; i++) {
      var b = p[i].bounds;
      if (b.min.x < L) L = b.min.x;
      if (b.max.x > R) R = b.max.x;
      if (b.min.y < T) T = b.min.y;
      if (b.max.y > B) B = b.max.y;
    }
    return { minX: L, maxX: R, minY: T, maxY: B };
  }

  /** 潰れ具合。1 = 元の高さ、0.7 = 3割潰れている */
  function squash(jelly) {
    var b = bounds(jelly);
    return (b.maxY - b.minY) / jelly.type.h;
  }

  var SoftJelly = {
    DEFAULTS: DEFAULTS,
    setMatter: function (m) { M = m; },
    arena: arena,
    create: create,
    add: add,
    outline: outline,
    centroid: centroid,
    bounds: bounds,
    squash: squash
  };

  root.SoftJelly = SoftJelly;
})(typeof window !== 'undefined' ? window : globalThis);
