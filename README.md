# model-director

**Claude Code 上で「二刀流」開発フローを指揮する**スキル。サブタスクごとに
Claude モデル（Fable / Opus / Sonnet）と OpenAI GPT-5.6 系列（sol / terra / luna、
OpenAI Codex CLI 経由）へ振り分け、Anthropic と OpenAI 両方のサブスクリプションへ
負荷を分散しつつ、希少な Fable クォータを温存します。

---

## これは何を解決するか

- Fable は強力だが枠が少ない。全サブタスクを Fable に投げるとすぐ枯渇する
- Opus / Sonnet だけでは、フロンティア級の設計判断が必要な場面で手薄になることがある
- GPT-5.6 系（Codex CLI 経由の sol / terra / luna）を併用すれば、Anthropic 側の
  クォータを温存しつつ、クロスモデルレビューで単一モデルの見落としを拾える

model-director はサブタスクの実行前に必ず **Model Deliberation Gate** を通し、
「どのモデルが最適か」「フォールバック先はどれか」を機械的に決定してログに残します。

---

## アーキテクチャ

model-director は「どのモデルを使うか」を決める**ポリシー層**であり、実際に
GPT/Codex を呼び出す配線（**トランスポート層**）は再実装せず、既存の
`claude-to-codex` スキルに委譲します。

```
┌───────────────────────────────┐
│        model-director          │  ← ポリシー層
│   Model Deliberation Gate      │     (どのモデルに振るか決定)
│   scripts/model-gate.sh        │
└───────────────┬─────────────────┘
                │ GPT/Codex 実行時のみ呼び出す
                ▼
┌───────────────────────────────┐
│        claude-to-codex          │  ← トランスポート層
│ scripts/codex-run.sh -m <model> │     (認証・再接続・実行)
└───────────────────────────────┘
```

Claude Code 本体は常に Claude 側（Opus のメインループ）に留まり、サブタスクだけが
モデル間を移動します。

---

## モデル振り分け

| フェーズ | 第一候補 | フォールバック | 経由 |
|---------|---------|----------------|------|
| Planning（計画） | Fable | gpt-5.6-sol → Opus | Claude Code / Codex CLI |
| Execution（実行） | Opus / Sonnet（Agent サブエージェント） | gpt-5.6-terra → gpt-5.6-sol | Claude Code / Codex CLI |
| Review（レビュー） | クロスモデル（実行と異なるプロバイダ） | gpt-5.6-sol ⇄ Fable | 両方 |

Fable がレート制限にかかっている場合、Planning は自動的に `gpt-5.6-sol` に代替されます。

### Model Deliberation Gate

サブタスクを実行する前に必ず通過するゲート。以下を機械的に評価します:

1. 各モデルの強み・弱み（`scripts/model-profiles.json` の `strengths` / `weaknesses`）
2. 残りクォータ（`subscriptions.*.windows[].soft_budget`、5時間ローリングウィンドウ）
3. タスクの複雑度（`min_complexity`）とロール（`roles`）
4. 上記から最適モデルを1つ選び、`fallback_chains` に従ったフォールバック順序を確定
5. 選択モデル・理由・フォールバック順をログに記録

Fable の残クォータが `fable_min_remaining_ratio`（既定 0.35）を下回ると、
Planning / Review の候補から自動的に外れます。

---

## インストール

`set_up.sh`（単一インストーラ）経由で `~/.claude/skills/model-director` に
クローンされます。

### 前提条件

- Node.js
- OpenAI Codex CLI `>=0.144.4`（認証済み）
- `claude-to-codex` スキル（`~/.claude/skills/claude-to-codex` にインストール済みで、
  GPT 実行ブリッジとして利用）

model-director は `claude-to-codex/scripts/codex-run.sh -m <model>` を呼び出すだけで、
Codex CLI の認証・再接続ロジックを自前で再実装しません。

---

## ファイル構成

```
model-director/
├── SKILL.md                       # スキル定義本体
├── VERSION
├── LICENSE
├── README.md
├── references/
│   ├── deliberation.md            # Model Deliberation Gate の判断ロジック詳細
│   └── model-profiles.md          # モデルごとの強み/弱み/クォータの解説
├── scripts/
│   ├── model-gate.sh              # ゲートのエントリポイント
│   ├── model-profiles.json        # ルーティング設定（コスト・希少性・fallback_chains）
│   └── lib/
│       └── model-gate.js          # ゲートのコアロジック
└── tests/                         # ゲート判定のテスト
```

---

## ライセンス

MIT — 詳細は [LICENSE](./LICENSE) を参照。
