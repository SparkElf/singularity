import {
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from "@nestjs/common";
import { z, type ZodTypeAny } from "zod";

import { validationFailed } from "../problem.js";

@Injectable()
export class ZodValidationPipe<Schema extends ZodTypeAny>
  implements PipeTransform<unknown, z.infer<Schema>>
{
  constructor(private readonly schema: Schema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<Schema> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw validationFailed();
    }
    return parsed.data;
  }
}
