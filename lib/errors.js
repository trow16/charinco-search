// API が返すエラー（status はそのまま HTTP のステータスになる）
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
