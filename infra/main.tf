/**
 * プロバイダ・backend・共通タグ。
 *
 * 構成はルートモジュール1つ・state 1本。環境が1つ・リージョンが1つ・開発者が1人で
 * 再利用の機会がないため、モジュール化はしない（docs/context.md 8/6 の判断）。
 * ファイルはリソース種別で分ける。
 */

terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    # Lambda のデプロイパッケージ（zip）を Terraform 側で作るために使う
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # bucket / key / region は terraform init -backend-config= で渡す。
  # バケット名を直書きしないのは、public リポジトリに載せないため（infra/README.md）。
  backend "s3" {
    # Terraform 1.11 以降の S3 ネイティブロック。
    # ロック専用の DynamoDB テーブルを別に用意しなくてよい（作るテーブルが1本減る）。
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  # 全リソースに付ける。コスト配分タグで請求を追えるようにするため
  default_tags {
    tags = {
      Project   = "q-documents"
      ManagedBy = "terraform"
    }
  }
}

/**
 * アカウントIDを参照する。
 *
 * S3 からの Lambda 呼び出し許可（lambda.tf の aws_lambda_permission）に使う。
 * バケット名は全世界で一意だが、**S3 の source_arn にはアカウントIDが含まれない**ため、
 * バケットを消したあと他人に同じ名前を取られると、その通知でこちらの Lambda が
 * 呼ばれうる。source_account を併記して自分のアカウントからの呼び出しに限る。
 *
 * 値を直書きしないのは、public リポジトリにアカウントIDを載せないため（main.tf 冒頭と同じ理由）。
 */
data "aws_caller_identity" "current" {}

/**
 * S3 バケット名は全世界で一意でなければならない。
 * アカウントIDを名前に含める方法もあるが、public リポジトリにアカウントIDを載せたくない。
 * 4バイトのランダム値を suffix にすると、state には残るがコードには出ない。
 */
resource "random_id" "suffix" {
  byte_length = 4
}
