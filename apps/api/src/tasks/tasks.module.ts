import { Global, Module } from '@nestjs/common';

import { HumanTaskController } from './human-task.controller.js';
import { HumanTaskService } from './human-task.service.js';

/**
 * The Human To-do list.
 *
 * `@Global` for the same reason the objectives module is: the Executor Agent, performance events
 * and the dashboard's Pending Jobs count all need to ask about somebody's work, and one service
 * answering that is one place where the scope rule is applied.
 *
 * Its own module rather than part of Objectives, because `todo` is its own permission set at its
 * own scope — an Employee works their tasks without any right to browse objectives, and that
 * separation could not be expressed if the routes lived under the objective module.
 */
@Global()
@Module({
  controllers: [HumanTaskController],
  providers: [HumanTaskService],
  exports: [HumanTaskService],
})
export class TasksModule {}
