import { Global, Module } from '@nestjs/common';

import { AgentBuilderController } from './agent-builder.controller.js';
import { AgentOperatorController } from './agent-operator.controller.js';
import { AgentOperatorService } from './agent-operator.service.js';
import { JobMethodController } from './job-method.controller.js';
import { JobMethodService } from './job-method.service.js';
import { AgentBuilderService } from './agent-builder.service.js';
import { EngineAgentController } from './engine-agent.controller.js';
import { EngineAgentService } from './engine-agent.service.js';
import { FeedbackController } from './feedback.controller.js';
import { FeedbackService } from './feedback.service.js';
import { MemoryController, MemoryPlatformController } from './memory.controller.js';
import { MemoryService } from './memory.service.js';

/**
 * Agent Builder and the reusable Engine Agent.
 *
 * `@Global` for the same reason as Objectives and Tasks: the Executor Agent, the run engine and
 * the dashboard's Agents count all need to ask about an agent, and one service answering that is
 * one place where the scope rule is applied.
 *
 * Its own module rather than part of Objectives, because `agent-builder` is its own permission set
 * at its own scope. An Employee sets up and activates the agent for their own assigned step
 * without any right to browse objectives, and that separation could not be expressed if these
 * routes lived under the objective module.
 *
 * The registry (Prompt 25) lives here too, on the same identity: list, detail, pause, resume,
 * archive, and the draft-test-activate version flow. Runs are the next prompt, and they hang off
 * this identity rather than beside it — which is why `Run Now` has no route yet.
 *
 * **Memory and output feedback (Prompt 33) live here for the same reason.** Memory is an Engine
 * Agent's memory, governed by the mode its published version declares; feedback is a judgement of
 * what one of its runs produced. Both are properties of this identity rather than subjects of
 * their own, and a separate module would have meant a second place the agent scope rule is
 * applied.
 */
@Global()
@Module({
  controllers: [
    AgentBuilderController,
    // Prompt 40A: the operator-facing half, gated on `agents:*` and never on `agent-builder`.
    AgentOperatorController,
    JobMethodController,
    EngineAgentController,
    MemoryController,
    MemoryPlatformController,
    FeedbackController,
  ],
  providers: [
    AgentBuilderService,
    AgentOperatorService,
    JobMethodService,
    EngineAgentService,
    MemoryService,
    FeedbackService,
  ],
  exports: [
    AgentBuilderService,
    AgentOperatorService,
    JobMethodService,
    EngineAgentService,
    MemoryService,
    FeedbackService,
  ],
})
export class AgentsModule {}
