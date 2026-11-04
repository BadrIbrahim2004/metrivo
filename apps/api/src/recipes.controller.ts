import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { RequireTenantPermission } from "./authz.decorator";
import {
  ListWasteDto,
  ProduceBatchDto,
  RecordWasteDto,
  SaveRecipeDto,
} from "./recipes.dto";
import {
  INVENTORY_WASTE_PERMISSION,
  RECIPES_MANAGE_PERMISSION,
  RECIPES_READ_PERMISSION,
  RecipesService,
} from "./recipes.service";

interface RecipesRequest {
  user?: { userId?: unknown };
}

@Controller("tenants/:tenantId/branches/:branchId")
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

  @RequireTenantPermission(RECIPES_READ_PERMISSION)
  @Get("recipes")
  listRecipes(
    @Req() request: RecipesRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
  ) {
    return this.recipes.listRecipes(
      this.requireActorId(request),
      tenantId,
      branchId,
    );
  }

  @RequireTenantPermission(RECIPES_MANAGE_PERMISSION)
  @Post("recipes")
  saveRecipe(
    @Req() request: RecipesRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Body() input: SaveRecipeDto,
  ) {
    return this.recipes.saveRecipe(
      this.requireActorId(request),
      tenantId,
      branchId,
      input,
    );
  }

  @RequireTenantPermission(RECIPES_MANAGE_PERMISSION)
  @Post("production-batches")
  produceBatch(
    @Req() request: RecipesRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() input: ProduceBatchDto,
  ) {
    return this.recipes.produceBatch(
      this.requireActorId(request),
      tenantId,
      branchId,
      idempotencyKey ?? "",
      input,
    );
  }

  @RequireTenantPermission(RECIPES_READ_PERMISSION)
  @Get("production-batches")
  listBatches(
    @Req() request: RecipesRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
  ) {
    return this.recipes.listBatches(this.requireActorId(request), tenantId, branchId);
  }

  @RequireTenantPermission(RECIPES_READ_PERMISSION)
  @Get("waste")
  listWaste(
    @Req() request: RecipesRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Query() query: ListWasteDto,
  ) {
    return this.recipes.listWaste(
      this.requireActorId(request),
      tenantId,
      branchId,
      query,
    );
  }

  @RequireTenantPermission(INVENTORY_WASTE_PERMISSION)
  @Post("waste")
  recordWaste(
    @Req() request: RecipesRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() input: RecordWasteDto,
  ) {
    return this.recipes.recordWaste(
      this.requireActorId(request),
      tenantId,
      branchId,
      idempotencyKey ?? "",
      input,
    );
  }

  @RequireTenantPermission(INVENTORY_WASTE_PERMISSION)
  @Delete("waste/:wasteId")
  voidWaste(
    @Req() request: RecipesRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Param("wasteId") wasteId: string,
  ) {
    return this.recipes.voidWaste(
      this.requireActorId(request),
      tenantId,
      branchId,
      wasteId,
    );
  }

  private requireActorId(request: RecipesRequest): string {
    const userId = request.user?.userId;
    if (typeof userId !== "string" || userId.length === 0) {
      throw new UnauthorizedException("Authenticated user is required");
    }
    return userId;
  }
}
