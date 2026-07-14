import {
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  DATABASE_READINESS_PATH,
  DATABASE_READY_OPENAPI_SCHEMA,
  DATABASE_READY_RESPONSE,
  DATABASE_UNAVAILABLE_OPENAPI_SCHEMA,
  DATABASE_UNAVAILABLE_RESPONSE,
  type DatabaseReadinessResponse,
} from "@singularity/contracts";
import { DatabaseRuntime } from "@singularity/database";

@ApiTags("health")
@Controller(DATABASE_READINESS_PATH)
export class DatabaseHealthController {
  constructor(private readonly database: DatabaseRuntime) {}

  @Get()
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Check PostgreSQL readiness" })
  @ApiProduces("application/json")
  @ApiOkResponse({ schema: DATABASE_READY_OPENAPI_SCHEMA })
  @ApiServiceUnavailableResponse({
    schema: DATABASE_UNAVAILABLE_OPENAPI_SCHEMA,
  })
  async getReadiness(): Promise<DatabaseReadinessResponse> {
    try {
      await this.database.client.$queryRaw`SELECT 1`;
      return DATABASE_READY_RESPONSE;
    } catch (error) {
      throw new ServiceUnavailableException(DATABASE_UNAVAILABLE_RESPONSE, {
        cause: error,
      });
    }
  }
}
