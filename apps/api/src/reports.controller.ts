import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { RequireTenantPermission } from "./authz.decorator";
import { ProductPerformanceQueryDto, ReportQueryDto } from "./reports.dto";
import { REPORTS_READ_PERMISSION, ReportsService } from "./reports.service";

interface ReportsRequest {
  user?: { userId?: unknown };
}

@Controller("tenants/:tenantId/branches/:branchId/reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequireTenantPermission(REPORTS_READ_PERMISSION)
  @Get("dashboard")
  dashboardSummary(
    @Req() request: ReportsRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Query() query: ReportQueryDto,
  ) {
    return this.reports.dashboardSummary(
      this.requireActorId(request),
      tenantId,
      branchId,
      query,
    );
  }

  @RequireTenantPermission(REPORTS_READ_PERMISSION)
  @Get("products/performance")
  productPerformance(
    @Req() request: ReportsRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Query() query: ProductPerformanceQueryDto,
  ) {
    return this.reports.productPerformance(
      this.requireActorId(request),
      tenantId,
      branchId,
      query,
    );
  }

  @RequireTenantPermission(REPORTS_READ_PERMISSION)
  @Get("inventory")
  inventoryStatus(
    @Req() request: ReportsRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
  ) {
    return this.reports.inventoryStatus(
      this.requireActorId(request),
      tenantId,
      branchId,
    );
  }

  @RequireTenantPermission(REPORTS_READ_PERMISSION)
  @Get("expenses")
  expenseSummary(
    @Req() request: ReportsRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Query() query: ReportQueryDto,
  ) {
    return this.reports.expenseSummary(
      this.requireActorId(request),
      tenantId,
      branchId,
      query,
    );
  }

  private requireActorId(request: ReportsRequest): string {
    const userId = request.user?.userId;
    if (typeof userId !== "string" || userId.length === 0) {
      throw new UnauthorizedException("Authenticated user is required");
    }
    return userId;
  }
}
