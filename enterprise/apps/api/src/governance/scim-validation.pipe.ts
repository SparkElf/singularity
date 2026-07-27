import { Injectable, type PipeTransform } from "@nestjs/common";
import { z, type ZodTypeAny } from "zod";

import { scimError } from "../problem.js";

/** 在 SCIM 协议边界只解析一次请求，并把失败转换成标准 SCIM Error 响应。 */
@Injectable()
export class ScimValidationPipe<Schema extends ZodTypeAny>
  implements PipeTransform<unknown, z.infer<Schema>>
{
  constructor(private readonly schema: Schema) {}

  transform(value: unknown): z.infer<Schema> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw scimError(400, "The SCIM request does not satisfy the resource contract", "invalidSyntax");
    }
    return parsed.data as z.infer<Schema>;
  }
}
