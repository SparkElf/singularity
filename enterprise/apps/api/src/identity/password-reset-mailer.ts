import { Injectable } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";

export interface PasswordResetMailer {
  readonly configured: boolean;
  send(input: { recipient: string; resetUrl: string }): Promise<void>;
}

export interface PasswordResetMailerOptions {
  readonly from: string | undefined;
  readonly smtpUrl: string | undefined;
}

/** 通过 SMTP 投递密码找回邮件；传输层不接触数据库 token 摘要或用户密码。 */
@Injectable()
export class SmtpPasswordResetMailer implements PasswordResetMailer {
  readonly #from: string | undefined;
  readonly #smtpUrl: string | undefined;
  #transport: Transporter | undefined;

  constructor(options: PasswordResetMailerOptions) {
    this.#from = options.from;
    this.#smtpUrl = options.smtpUrl;
  }

  get configured(): boolean {
    return this.#from !== undefined && this.#smtpUrl !== undefined;
  }

  /** 创建复用 SMTP transport 并投递邮件，失败时保留原始异常供全局边界记录。 */
  async send(input: { recipient: string; resetUrl: string }): Promise<void> {
    if (!this.configured || this.#from === undefined || this.#smtpUrl === undefined) {
      throw new Error("Password reset SMTP delivery is not configured");
    }
    this.#transport ??= createTransport(this.#smtpUrl);
    await this.#transport.sendMail({
      from: this.#from,
      subject: "重置奇点密码",
      text: `请打开以下链接重置奇点密码（链接 30 分钟内有效且只能使用一次）：\n\n${input.resetUrl}\n`,
      to: input.recipient,
    });
  }

  /** 应用关闭时释放 SMTP transport，避免连接池阻止 Node 进程退出。 */
  onApplicationShutdown(): void {
    this.#transport?.close();
  }
}
