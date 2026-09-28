/* dsh-md-MemoryOS · 控制面板（设置 → 记忆系统）
 *
 * 形态：手写 cordis client 工厂 bundle——`window.__ModuleLoader__.load({id, factory})`，零构建链
 * （react 走平台种子词解析）。为什么不上打包器：本包只有这一个浏览器文件。
 *
 * 装载契约（四条，缺一面板就不出现，且**零日志**——实测自 dsh-selfevolve 的踩坑账）：
 *   1. package.json 有 `dsh.client.platform = "web"`；
 *   2. package.json 有 `exports["./client"]` 指向本文件；
 *   3. package.json 有 `exports["./package.json"]`：装载器用 require.resolve('<pkg>/package.json')
 *      扫声明，解析失败被**静默 catch**（症状＝/plugins/<id>/client.js 404、设置页根本没那一项）；
 *   4. `load({id})` 的 id 必须等于 package.json 的 name。
 *
 * 取数：全部走宿主 HTTP 面 /api/dsh-md-MemoryOS/*（见 lib/api.js）。不缓存、**不轮询**——
 * 挂载读一次 + 手动刷新 + 每次写直接吃返回的新快照。
 *
 * 面板为什么长这样（2026-09-28 用户定的关键区分）：
 *   · 一类功能是**一键可切**（Toggle 有意义）；
 *   · 另一类是**配置型**：「打开」其实是一串动作（例：Jev 能力＝Key 到位 → 真发一次请求测通 → 才置生效）。
 *     这类**不给开关，只给状态 + 待办步骤 + 该谁做**，操作由模型执行；用户保留「接管」这条退路。
 *     没做完前置步骤就显示"生效中"是骗人，所以状态里单列一档「待配置」。
 */
window.__ModuleLoader__.load({
	id: "dsh-md-MemoryOS",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");
		var e = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;
		var useCallback = react.useCallback;

		var API = "/api/dsh-md-MemoryOS"; // 与 lib/api.js 的 PREFIX 同源（闸机检两处一致）

		/** 样式合并。**绝不能用 [a,b].reduce(Object.assign,{})**：reduce 会把索引与数组本身也喂给
		 *  assign，style 上多出 '0'/'1' 键 → React 写 el.style[0] 抛 "Indexed property setter is not
		 *  supported" → 整个 settings.section slot entry 崩（selfevolve 浏览器实测踩过）。 */
		function mix() { return Object.assign.apply(null, [{}].concat([].slice.call(arguments))); }

		var ST = {
			page: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: 880, color: "var(--dsw-alias-label-primary)" },
			h: { fontSize: 14, fontWeight: 600 },
			note: { fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary)" },
			card: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 },
			row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			title: { fontSize: 13, fontWeight: 600 },
			meta: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.6 },
			strong: { fontSize: 11, color: "var(--dsw-alias-label-primary)" },
			badge: { fontSize: 11, padding: "1px 6px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap" },
			badgeOk: { borderColor: "var(--dsw-alias-status-success, #2a7)", color: "var(--dsw-alias-status-success, #2a7)" },
			badgeWarn: { borderColor: "var(--dsw-alias-status-warning, #c60)", color: "var(--dsw-alias-status-warning, #c60)" },
			badgeDanger: { borderColor: "var(--dsw-alias-status-danger, #c33)", color: "var(--dsw-alias-status-danger, #c33)" },
			badgeOff: { opacity: 0.6 },
			btn: { fontSize: 12, padding: "3px 10px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "none", color: "inherit", cursor: "pointer" },
			tab: { fontSize: 12, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-l2)", background: "none", cursor: "pointer", color: "inherit" },
			tabOn: { background: "var(--dsw-alias-interactive-bg-active)", fontWeight: 600 },
			table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
			th: { textAlign: "left", fontSize: 11, color: "var(--dsw-alias-label-tertiary)", fontWeight: 500, padding: "3px 6px" },
			td: { padding: "4px 6px", borderTop: "1px solid var(--dsw-alias-border-l1)", verticalAlign: "top" },
			code: { fontFamily: "ui-monospace, monospace", fontSize: 11, color: "var(--dsw-alias-label-secondary)" },
		};

		var STATE_ZH = { on: "生效中", off: "已关", waiting: "待配置", degraded: "降级运行", unavailable: "不可用", planned: "未实现" };
		var CTRL_ZH = { user: "仅用户可切", llm: "由模型执行", both: "双方可切" };
		var IMPL_ZH = { live: "已实现", wiring: "已接线·待搬入", todo: "未实现" };

		function Badge(props) {
			var kind = props.kind;
			var style = kind === "ok" ? mix(ST.badge, ST.badgeOk)
				: kind === "warn" ? mix(ST.badge, ST.badgeWarn)
					: kind === "danger" ? mix(ST.badge, ST.badgeDanger)
						: mix(ST.badge, ST.badgeOff);
			return e("span", { style: style }, props.text);
		}

		function Toggle(props) {
			return e("button", {
				style: mix(ST.btn, { minWidth: 52, fontWeight: 600, background: props.on ? "var(--dsw-alias-interactive-bg-active)" : "none" }),
				disabled: !!props.busy, title: props.title || "", "data-sev": "mos:toggle:" + props.id,
				onClick: props.onClick,
			}, props.on ? "开" : "关");
		}

		function stateKind(s) {
			if (s === "on") return "ok";
			if (s === "waiting" || s === "degraded") return "warn";
			if (s === "unavailable") return "danger";
			return "off";
		}

		/** 前置步骤块（配置型功能的核心显示）：还差哪一步、这步该谁做、怎么做。 */
		function Steps(f) {
			if (!f.steps || !f.steps.length) return null;
			return e("div", { style: ST.meta }, "前置步骤：", f.steps.map(function (s) {
				return e("span", { key: s.id, style: { marginRight: 10 } },
					s.ok
						? Badge({ text: "✓ " + s.label, kind: "ok" })
						: Badge({ text: "○ " + s.label + "·" + (s.by === "llm" ? "模型执行" : "需用户提供"), kind: "warn" }),
					s.ok ? null : e("span", null, " ", s.why || s.how || ""));
			}));
		}

		function FeatureRow(props) {
			var f = props.f, busy = props.busy, act = props.act;
			var togglable = f.controller !== "llm" && f.impl !== "todo";
			var lockable = f.controller !== "user" && f.impl !== "todo";
			return e("div", { key: f.id, "data-sev": "mos:feat:" + f.id, style: mix(ST.card, { gap: 4 }) },
				e("div", ST.row,
					e("span", { style: ST.title }, f.label),
					Badge({ text: STATE_ZH[f.state] || f.state, kind: stateKind(f.state) }),
					Badge({ text: CTRL_ZH[f.controller] || f.controller, kind: f.controller === "user" ? "off" : "warn" }),
					f.locked ? Badge({ text: "已接管·模型改不动", kind: "ok" }) : null,
					Badge({ text: IMPL_ZH[f.impl] || f.impl, kind: f.impl === "live" ? "off" : "warn" })),
				e("div", { style: ST.note }, f.what),
				e("div", { style: f.source === "ledger" ? ST.strong : ST.meta },
					f.source === "ledger"
						? e("span", null, "谁定的：", f.by === "llm" ? "模型" : "用户", " · 理由：", f.reason || "（没写）", " · ", String(f.ts || "").replace("T", " ").slice(0, 19))
						: e("span", null, "谁定的：", f.source === "config" ? "profile 配置默认（无人改过）" : "出厂默认（无人改过）")),
				e("div", { style: ST.meta }, "成本：", f.cost),
				Steps(f),
				f.missing && f.missing.length
					? e("div", { style: ST.meta }, "缺依赖：", f.missing.map(function (m) {
						return e("span", { key: m.id, style: { marginRight: 8 } },
							Badge({ text: m.label + (m.hard ? "·硬" : "·可降级"), kind: m.hard ? "danger" : "warn" }),
							m.why ? e("span", null, " ", m.why) : null);
					}))
					: null,
				e("div", ST.row,
					togglable
						? Toggle({
							id: f.id, on: !!f.value, busy: busy, title: "切「" + f.label + "」（写一行账，热生效不重启）",
							onClick: function () { act({ path: "/switch", body: { feature: f.id, value: !f.value } }); },
						})
						: null,
					f.controller === "llm" && f.impl !== "todo"
						? e("span", { style: ST.meta }, "（这项不给开关：开启＝一串动作，请在对话里让模型做完，做完状态自动变「生效中」）")
						: null,
					f.impl === "todo" ? e("span", { style: ST.meta }, "（代码未实现，故不给开关——面板不许骗人）") : null,
					lockable
						? e("button", {
							style: ST.btn, disabled: busy, "data-sev": "mos:lock:" + f.id,
							title: f.locked ? "解除接管：把决定权交还模型" : "接管：锁定为你说了算，模型再操作会被拒（理由回给它）",
							onClick: function () { act({ path: f.locked ? "/release" : "/takeover", body: { feature: f.id, value: !!f.value } }); },
						}, f.locked ? "解除接管" : "接管")
						: null));
		}

		function Features(props) {
			var s = props.snap;
			var groups = Object.keys(s.byGroup || {});
			return e("div", { style: ST.page },
				e("div", { style: ST.note },
					"状态＝", e("b", null, "现算"),
					"（切换账本最新行 > profile 默认 > 出厂默认，再叠依赖探针与前置步骤），刷新即重读；切换热生效不重启。",
					"标「由模型执行」的行没有开关——那是有意的：它的开启需要动作（测通、存 Key…），不是勾选。"),
				groups.map(function (g) {
					var rows = (s.byGroup[g] || []).filter(Boolean);
					if (!rows.length) return null;
					return e("div", { key: g, style: { display: "flex", flexDirection: "column", gap: 6 } },
						e("div", { style: ST.h }, g),
						rows.map(function (f) { return FeatureRow({ key: f.id, f: f, busy: props.busy, act: props.act }); }));
				}));
		}

		function Overview(props) {
			var s = props.snap;
			var n = { on: 0, off: 0, waiting: 0, degraded: 0, unavailable: 0, planned: 0 };
			for (var i = 0; i < s.features.length; i++) n[s.features[i].state] = (n[s.features[i].state] || 0) + 1;
			return e("div", { style: ST.page },
				e("div", { style: ST.card },
					e("div", { style: ST.h }, "这套东西管什么"),
					e("div", { style: ST.note },
						"以 md 文档为核心、以元素索引为线的记忆系统：", e("b", null, "建立"), "（建档入库）、",
						e("b", null, "维护"), "（建图体检·候选回灌）、", e("b", null, "使用"), "（资料亮起·检索出决策材料）。",
						"本页是它的总闸面板。")),
				e("div", { style: ST.card },
					e("div", { style: ST.h }, "当前统计"),
					e("div", ST.row,
						Badge({ text: "生效中 " + n.on, kind: "ok" }),
						Badge({ text: "待配置 " + n.waiting, kind: "warn" }),
						Badge({ text: "降级 " + n.degraded, kind: "warn" }),
						Badge({ text: "不可用 " + n.unavailable, kind: "danger" }),
						Badge({ text: "已关 " + n.off, kind: "off" }),
						Badge({ text: "未实现 " + n.planned, kind: "off" })),
					e("div", { style: ST.meta }, "Jev Key：", s.meta.key.present
						? Badge({ text: "在位 · " + s.meta.key.from + " · " + s.meta.key.masked, kind: "ok" })
						: Badge({ text: "无（" + (s.meta.key.hint || "未配置") + "）", kind: "warn" }),
						"｜模型可改开关：", s.meta.llmCanSwitch ? "可以" : "不可以（profile config.llmCanSwitch=false）",
						"｜模型可代存 Key：", s.meta.modelCanSaveKey ? "可以（优先写宿主凭据面，明文不进账本日志）" : "不可以"),
					(s.meta.key.warnings || []).length
						? e("div", { style: ST.meta }, s.meta.key.warnings.map(function (w) { return e("div", { key: w, style: { color: "var(--dsw-alias-status-warning, #c60)" } }, w); }))
						: null),
				e("div", { style: ST.card },
					e("div", { style: ST.h }, "两种控制权，看懂这页只要这两句"),
					e("div", { style: ST.note }, e("b", null, "「仅用户可切」"), "＝模型调工具改它会被当场拒绝，拒绝理由原样回给模型；"),
					e("div", { style: ST.note }, e("b", null, "「由模型执行」"), "＝开启需要动作（测通、存 Key…），面板只显示状态与待办；你点「接管」可锁成自己说了算，随时可解除。"),
					e("div", { style: ST.meta }, "所有操作都是 append-only 一行账（见「账本」页）：谁做的、为什么、什么时候，历史永不改写。")));
		}

		function Deps(props) {
			var s = props.snap;
			return e("div", { style: ST.page },
				e("div", { style: ST.note }, "依赖探针（本地 fs/env，零网络，5 秒缓存）。缺「硬」＝该功能不可用；缺「可降级」＝照常跑但效果打折。"),
				e("table", { style: ST.table },
					e("thead", null, e("tr", null, e("th", { style: ST.th }, "依赖"), e("th", { style: ST.th }, "性质"), e("th", { style: ST.th }, "探针结果"))),
					e("tbody", null, s.deps.map(function (d) {
						var good = d.result === true;
						return e("tr", { key: d.id, "data-sev": "mos:dep:" + d.id },
							e("td", { style: ST.td }, e("div", null, d.label), e("code", { style: ST.code }, d.id)),
							e("td", { style: ST.td }, d.hard ? Badge({ text: "硬", kind: "danger" }) : Badge({ text: "可降级", kind: "warn" })),
							e("td", { style: ST.td }, good ? Badge({ text: "正常", kind: "ok" }) : Badge({ text: "缺失", kind: d.hard ? "danger" : "warn" }), " ",
								good ? d.note : String(d.result)));
					}))),
				e("div", { style: ST.card },
					e("div", { style: ST.h }, "路径与配置（改这些在 profile 的 cordis.patch.yml，不在面板里）"),
					["memoryRoot", "pythonBin", "graphDb", "kernelRepo", "keyFile"].map(function (k) {
						var v = s.meta.configHints[k];
						return e("div", { key: k, style: ST.meta }, k, "＝", e("code", { style: ST.code }, Array.isArray(v) ? (v.join("  |  ") || "（未设置）") : (v || "（未设置）")));
					}),
					e("div", { style: ST.meta }, "账本目录＝", e("code", { style: ST.code }, s.meta.dataDir))));
		}

		function Table(headers, rows, mk) {
			return e("table", { style: ST.table },
				e("thead", null, e("tr", null, headers.map(function (h) { return e("th", { key: h, style: ST.th }, h); }))),
				e("tbody", null, rows.map(mk)));
		}

		function Ledger(props) {
			var s = props.snap;
			var rows = s.ledger || [];
			var setup = s.setup || [];
			return e("div", { style: ST.page },
				e("div", { style: ST.card },
					e("div", { style: ST.h }, "开关账本"),
					e("div", { style: ST.meta }, "append-only，一次操作＝一行：", e("code", { style: ST.code }, s.ledgerMeta.file),
						"｜共 ", e("b", null, s.ledgerMeta.lines), " 行",
						s.ledgerMeta.corrupt ? "｜坏行 " + s.ledgerMeta.corrupt + "（读时跳过，不影响功能）" : ""),
					rows.length === 0
						? e("div", { style: ST.note }, "（还没有任何切换记录——所有功能当前都跟随默认值）")
						: Table(["时间", "功能", "值", "谁", "理由", "接管"], rows, function (r, i) {
							return e("tr", { key: (r.key || "r") + i, "data-sev": "mos:row:" + String(r.key) },
								e("td", { style: ST.td }, String(r.ts || "").replace("T", " ").slice(0, 19)),
								e("td", { style: ST.td }, e("code", { style: ST.code }, String(r.key || "?"))),
								e("td", { style: ST.td }, r.value ? Badge({ text: "开", kind: "ok" }) : Badge({ text: "关", kind: "off" })),
								e("td", { style: ST.td }, r.by === "llm" ? "模型" : "用户"),
								e("td", { style: ST.td }, String(r.reason || "（没写）")),
								e("td", { style: ST.td }, r.lock === true ? "接管" : r.lock === false ? "解除" : ""));
						})),
				e("div", { style: ST.card },
					e("div", { style: ST.h }, "配置账本（做过哪些准备动作）"),
					e("div", { style: ST.meta }, "测通／代存 Key 等结果：", e("code", { style: ST.code }, s.setupMeta.file),
						"｜新鲜度 ", s.setupMeta.freshDays, " 天（过期回退成「待重测」，功能状态随之变「待配置」）",
						s.setupMeta.corrupt ? "｜坏行 " + s.setupMeta.corrupt : ""),
					setup.length === 0
						? e("div", { style: ST.note }, "（还没做过任何配置动作——所以带前置步骤的功能现在只能是「待配置」）")
						: Table(["时间", "步骤", "结果", "谁", "说明", "理由"], setup, function (r, i) {
							return e("tr", { key: (r.step || "s") + i, "data-sev": "mos:setup:" + String(r.step) },
								e("td", { style: ST.td }, String(r.ts || "").replace("T", " ").slice(0, 19)),
								e("td", { style: ST.td }, e("code", { style: ST.code }, String(r.step || "?"))),
								e("td", { style: ST.td }, r.ok ? Badge({ text: "成功", kind: "ok" }) : Badge({ text: "失败", kind: "danger" })),
								e("td", { style: ST.td }, r.by === "llm" ? "模型" : "用户"),
								e("td", { style: ST.td }, String(r.note || "") + (typeof r.latencyMs === "number" ? "（" + r.latencyMs + "ms）" : "")),
								e("td", { style: ST.td }, String(r.reason || "")));
						}),
					e("div", { style: ST.meta }, "Key 明文只落文件：不进本账、不进日志、不回显，这里最多出现掩码。")));
		}

		var TABS = [["feat", "功能开关"], ["overview", "概览"], ["deps", "依赖与路径"], ["ledger", "账本"]];

		function Panel() {
			var st = useState(null), snap = st[0], setSnap = st[1];
			var bs = useState(false), busy = bs[0], setBusy = bs[1];
			var ms = useState(""), msg = ms[0], setMsg = ms[1];
			var es = useState(""), err = es[0], setErr = es[1];
			var ts = useState("feat"), tab = ts[0], setTab = ts[1];

			var load = useCallback(function () {
				setBusy(true);
				fetch(API + "/snapshot", { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (d) { if (d && d.ok) { setSnap(d.snapshot); setErr(""); } else { setErr((d && d.error) || "快照返回异常"); } })
					.catch(function (x) { setErr("读不到宿主数据面（headless profile 没有 webServer 属预期）：" + String((x && x.message) || x)); })
					.finally(function () { setBusy(false); });
			}, []);
			useEffect(load, [load]);

			/** 唯一写通路：一次点击＝一个请求＝一行账；返回即带最新快照。 */
			function act(req) {
				setBusy(true);
				fetch(API + req.path, {
					method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify(req.body || {}), cache: "no-store",
				})
					.then(function (res) { return res.json().then(function (d) { return { status: res.status, d: d }; }); })
					.then(function (r) {
						if (r.d && r.d.ok) { setSnap(r.d.snapshot); setMsg(r.d.message || "已记账"); setErr(""); }
						else { setErr((r.d && r.d.message) || ("HTTP " + r.status)); setMsg(""); }
					})
					.catch(function (x) { setErr("写入失败：" + String((x && x.message) || x)); })
					.finally(function () { setBusy(false); });
			}

			var body;
			if (!snap) {
				body = e("div", { style: ST.card },
					e("div", { style: ST.h }, busy ? "读取中…" : "没有数据"),
					err ? e("div", { style: ST.note }, err) : null,
					e("div", { style: ST.meta }, "面板不缓存快照：点右上「刷新」即重读宿主现算状态。"));
			} else if (tab === "feat") body = Features({ snap: snap, busy: busy, act: act });
			else if (tab === "overview") body = Overview({ snap: snap });
			else if (tab === "deps") body = Deps({ snap: snap });
			else body = Ledger({ snap: snap });

			return e("div", { style: ST.page },
				e("div", ST.row,
					e("div", { style: ST.h }, "记忆系统 MemoryOS", snap ? e("span", { style: ST.meta }, " v" + snap.meta.version) : null),
					e("span", { style: { flex: 1 } }),
					msg ? e("span", { style: ST.meta }, "✓ " + msg) : null,
					err ? e("span", { style: mix(ST.badge, ST.badgeDanger) }, "✗ " + err) : null,
					e("button", { style: ST.btn, disabled: busy, onClick: load, "data-sev": "mos:reload" }, busy ? "读取中…" : "刷新")),
				e("div", ST.row, TABS.map(function (t) {
					return e("button", { key: t[0], style: tab === t[0] ? mix(ST.tab, ST.tabOn) : ST.tab, "data-sev": "mos:tab:" + t[0], onClick: function () { setTab(t[0]); } }, t[1]);
				})),
				body);
		}

		exports.inject = ["slots"];
		exports.apply = function (ctx) {
			// web 组合下 apply 返回 disposer 数组会被判 Invalid effect ⇒ 一律返回单个包装函数。
			var offs = [];
			function keep(off) { if (typeof off === "function") offs.push(off); }
			keep(ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "memoryos", // 自己的新座位（复用已发布的 id＝把人家那一格换掉）
					order: 120, // 导航位置：出厂分区与 selfevolve(101) 之后
					label: function () { return "记忆系统"; }, // thunk：导航投影时按当前 locale 重读
					inject: function () { return {}; },
				}, Panel);
			}));
			return function disposeMemoryOSClient() {
				for (var i = 0; i < offs.length; i++) { try { offs[i](); } catch (err) { /* 卸载绝不抛 */ } }
			};
		};

		return module.exports;
	},
});