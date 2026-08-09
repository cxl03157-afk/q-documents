/**
 * DynamoDB クライアント。
 *
 * モジュールスコープに1つだけ置く。ハンドラの中で作ると、実行環境が再利用されても
 * リクエストごとに接続と認証情報の解決をやり直すことになる。
 *
 * DocumentClient を使うのは、`{ S: '...' }` 形式の属性値マップを書かずに
 * 素の JavaScript オブジェクトで読み書きするため。shared/types.ts の型を
 * そのまま渡せるので、台帳の属性名を2か所で管理せずに済む。
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {
    /**
     * `undefined` の属性を書かない。
     *
     * これが無いと、ファイル未登録のレコードで `s3KeyPdf: undefined` を渡したときに
     * エラーになる。shared/types.ts では両キーを optional にしてあり、
     * 「属性が存在しない」ことが状態5値と対応しているため（CLAUDE.md §5）、
     * 落とす側に倒すのが設計と一致する。
     */
    removeUndefinedValues: true,
  },
});
