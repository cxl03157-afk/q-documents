# Q-documents

製造現場の品質文書（PFMEA / QC工程表 / 作業指示書）を管理するWebアプリケーション。
文書番号の採番、台帳管理、改訂、旧版の自動アーカイブをブラウザ上で完結させる。

> **開発中（2026/7/31 〜 8/24）。** 本READMEは暫定版です。完成時に設計の要約と実運用時の課題を追記します。

## 背景

品質文書の台帳をエクセルで手作業管理しているため、記入漏れ・採番ルール違反・旧版の誤使用が発生している。
新規文書発行にかかる時間を30分から10分以下にすることを目標とする。

## 技術構成


| 領域      | 採用technology                            |
| ------- | --------------------------------------- |
| フロントエンド | Vite + TypeScript（フレームワークなし）            |
| バックエンド  | AWS Lambda（Node.js 22 + TypeScript）     |
| データストア  | Amazon DynamoDB / Amazon S3             |
| 配信・API  | CloudFront + OAC / API Gateway REST API |
| IaC     | Terraform                               |


サーバーレス構成とし、月額運用コスト1,000円以内を要件とする。
選定理由は [docs/tech-stack.md](docs/tech-stack.md) に記載。

## ドキュメント


| ファイル                                             | 内容                   |
| ------------------------------------------------ | -------------------- |
| [docs/要件定義書.md](docs/要件定義書.md)                   | 背景・機能要件・非機能要件・受け入れ基準 |
| [docs/tech-stack.md](docs/tech-stack.md)         | 技術選定と、採用しなかった技術の理由   |
| [docs/screens.md](docs/screens.md)               | 画面設計（7画面）            |
| [docs/API.md](docs/API.md)                       | APIエンドポイント一覧         |
| [docs/DynamoDBテーブル設計.md](docs/DynamoDBテーブル設計.md) | キー設計と採番ルール           |
| [docs/phase-roadmap.md](docs/phase-roadmap.md)   | 実装計画                 |
| [docs/構成図.drawio](docs/構成図.drawio)               | システム構成図              |




## 注記

本リポジトリはポートフォリオを目的として公開している。
実在する社内文書、ネットワーク情報、個人情報は一切含まない。