import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AccessModule } from './access/access.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CommercialModule } from './commercial/commercial.module.js';
import { ConnectionsModule } from './connections/connections.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { HealthModule } from './health/health.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { OrganizationModule } from './organization/organization.module.js';
import { PerformanceModule } from './performance/performance.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { ProvisioningModule } from './provisioning/provisioning.module.js';
import { RateLimitsModule } from './rate-limits/rate-limits.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { ModelGatewayModule } from './model-gateway/model-gateway.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { ApprovalsModule } from './approvals/approvals.module.js';
import { CostModule } from './cost/cost.module.js';
import { KnowledgeModule } from './knowledge/knowledge.module.js';
import { SupportModule } from './support/support.module.js';
import { ChatModule } from './chat/chat.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { ExecutorModule } from './executor/executor.module.js';
import { RunsModule } from './runs/runs.module.js';
import { ObjectivesModule } from './objectives/objectives.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { RewardsModule } from './rewards/rewards.module.js';
import { SkillsModule } from './skills/skills.module.js';
import { CorrelationIdMiddleware } from './request-context/correlation-id.middleware.js';
import { TenancyModule } from './tenancy/tenancy.module.js';

/**
 * Root application module.
 *
 * Feature modules are added one prompt at a time. There is still no login: authentication plugs
 * into the `ActorResolver` seam at Prompt 5, and until then the default resolver authenticates
 * nobody, so every non-public route is refused.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // .env.local overrides .env; neither is committed (see .gitignore).
      envFilePath: ['.env.local', '.env'],
    }),
    // ObservabilityModule first among the feature modules: a metric is recorded from
    // everywhere, so its @Global provider has to exist before anything that records one.
    ObservabilityModule,
    PersistenceModule,
    // AuditModule before AuthModule: SecurityEventPublisher injects SecurityEventService.
    AuditModule,
    // AuthModule before TenancyModule: the tenancy factory injects SessionActorResolver.
    AuthModule,
    AuthorizationModule,
    // RateLimitsModule after AuthorizationModule and before every feature module: its two
    // global interceptors must be the outermost pair, so a throttled request is refused
    // before it reaches anything that would do work or claim an idempotency key.
    RateLimitsModule,
    CommercialModule,
    // OrganizationModule provides HIERARCHY_RESOLVER, the seam AuthorizationModule declares and
    // deliberately leaves unprovided. Listed after it so the dependency direction is visible.
    OrganizationModule,
    // AccessModule after OrganizationModule: guests are defined by having no employment record,
    // and inviting somebody in the hierarchy needs the employment record to exist first.
    AccessModule,
    // PerformanceModule after AccessModule: offboarding writes the exit snapshot, so the
    // performance engine must be constructible by the time access is wired.
    PerformanceModule,
    // NotificationsModule after the modules that raise notifications, so the dependency
    // direction reads the way it runs: a producer is constructed, then the engine it calls.
    NotificationsModule,
    // ConnectionsModule after NotificationsModule: the credential-expiry sweep is the producer
    // behind the ConnectionExpiry notification kind Prompt 15 shipped with nothing raising it.
    ConnectionsModule,
    // SkillsModule after ConnectionsModule: a Skill declares the tool categories it needs, and
    // those come from the connection vocabulary.
    // ModelGatewayModule before anything that does AI work: the locked rule is that every model
    // call goes through this seam and provider names never leave it.
    ModelGatewayModule,
    SkillsModule,
    // ObjectivesModule after SkillsModule: an objective's AI steps will reference approved
    // published Skill versions, so the catalogue exists before the form that points at it.
    ObjectivesModule,
    // RewardsModule after ObjectivesModule: a reward hangs off an objective's reward rule, and
    // its points reach the score only through the performance policy.
    RewardsModule,
    // TasksModule after ObjectivesModule: a human task only exists because a workflow was
    // published, and the To-do screen reads the objective it came from.
    TasksModule,
    // AgentsModule after TasksModule: an assigned piece of AI work only exists because a
    // workflow was published, and Agent Builder reads the objective and the Skill behind it.
    AgentsModule,
    // RunsModule after AgentsModule: a run only exists for an activated agent, and the engine
    // reads the immutable version that agent has in force.
    RunsModule,
    // ExecutorModule after RunsModule: the sweep reads runs, tasks and connections, and one of
    // the things it looks for is the dead-letter path the run engine writes.
    ExecutorModule,
    // ApprovalsModule after ExecutorModule: the Executor asks for approvals it must not grant
    // itself, and this is the one engine every module raises them through.
    ApprovalsModule,
    // CostModule before nothing in particular, but its service is what the Model Gateway takes:
    // every AI call is checked, reserved and settled inside the one seam AI already goes through.
    CostModule,
    // KnowledgeModule before SettingsModule: Knowledge & Data is one of its screens, and both the
    // run engine and the Executor Agent need to ask it whether a file may be read or may leave.
    KnowledgeModule,
    // SupportModule before SettingsModule: a company reads its support tickets and the service
    // status from Settings, and the Master Console reads the same services.
    SupportModule,
    // ReportsModule last of all the feature modules, and deliberately: it reads every other
    // module’s tables and is read by none of them, so it is the leaf of the graph.
    ReportsModule,
    // ChatModule after ReportsModule and for the same reason: it reads other modules and is
    // read by none of them. Prompt 40A.
    ChatModule,
    // SettingsModule last of the company modules: its catalogue names permissions the
    // authorization engine owns, and its notes point at the screens the others build.
    SettingsModule,
    TenancyModule,
    ProvisioningModule,
    PlatformModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to every route, before guards, so even a rejected request has a correlation id
    // to quote — a denied request is exactly the one worth correlating with its logs.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*splat');
  }
}
