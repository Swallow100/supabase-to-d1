# Supabase to Cloudflare D1

Supabaseまたは一般的なPostgreSQLの通常テーブルを、Cloudflare D1向けのSQLite互換SQLへ変換するローカルCLIです。

単純なダンプ変換ではありません。最初に互換性を調べ、同一スナップショットからデータをストリーミングし、D1の文長制限に合わせてSQLを分割し、適用後に件数と外部キーを検証します。

> 現在は初期リリースです。remoteへ適用する前に、必ず新しいlocal D1で生成物を検証してください。

## 特徴

- `plan → export → apply → verify` の明示的な手順
- 移行元は読み取り専用・repeatable read
- 接続URLは環境変数からのみ取得し、生成物へ保存しない
- テレメトリなし、ランタイム依存パッケージなし
- D1向けにINSERTを安全な大きさへ分割
- remote書き込みには `--target remote --yes` の両方が必要
- RLS、関数、トリガーなどを黙って破棄せず、警告または停止
- 生成ファイルのSHA-256検証

## セットアップ

必要なものはNode.js 20以上、`psql`、適用時のWranglerです。

```bash
git clone https://github.com/Swallow100/supabase-to-d1.git
cd supabase-to-d1
npm install
npm link
```

## 基本操作

接続URLはコマンド引数ではなく環境変数へ入れます。

```bash
export SUPABASE_DB_URL='postgresql://USER:PASSWORD@HOST:5432/postgres?sslmode=require'

d1porter plan
d1porter export --out ./d1porter-output
```

local D1へ適用します。

```bash
d1porter apply \
  --bundle ./d1porter-output \
  --database app-db \
  --target local \
  --config ./wrangler.jsonc
```

localでアプリ側の動作まで確認した後、新しいremote D1へ明示的に適用します。

```bash
d1porter apply \
  --bundle ./d1porter-output \
  --database app-db \
  --target remote \
  --config ./wrangler.jsonc \
  --yes
```

## 対象

通常テーブル、行データ、主キー、一意制約、選択範囲内の外部キー、通常のbtree列インデックス、enum、`bytea`、JSON、日時、UUIDなどをD1向けに変換します。

`NUMERIC`は既定では精度を保つためTEXTへ保存します。計算用途でREALを選ぶ場合は `--numeric real` を指定しますが、精度低下の警告が出ます。

## 自動移行しないもの

次のものは意味が大きく異なるため、自動移行しません。

- Supabase Auth、Storage、Realtime、Edge Functions
- RLSポリシー、roles、grants
- PostgreSQLの関数、view、trigger
- partition、generated column、exclusion constraint
- PostgreSQL固有のindexやextension

特にRLSはD1のSQLへ置き換えるだけでは認可を維持できません。Cloudflare Workerまたはアプリケーション層で、認証と認可を再設計する必要があります。

## 生成物の扱い

生成ディレクトリにはデータベースの行が含まれます。バックアップと同じ機密度で扱ってください。誤commit防止用の`.gitignore`は生成されますが、強制追加や手動アップロードまでは防げません。

CLIが接続設定として使用したURL、パスワード、ホスト、Supabaseのproject reference、D1のdatabase IDを生成物へ追加することはありません。ただし、元テーブルの行自体に同種の値が保存されていれば、通常の行データとして出力されます。

`--force`で削除できるのは、空のディレクトリまたは本ツールの生成物マーカーを持つディレクトリだけです。無関係な非空ディレクトリは再帰削除しません。

詳しい互換性、安全設計、オプションは英語版 [README.md](README.md) を参照してください。

## ライセンス

MIT

SupabaseおよびCloudflareは各社の商標です。本プロジェクトは独立したものであり、両社との提携・承認関係はありません。
