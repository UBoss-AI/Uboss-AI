import { Global, Module } from '@nestjs/common';

import { ExecutorController } from './executor.controller.js';
import { ExecutorService } from './executor.service.js';

/**
 * The Executor Agent and the Exception Center.
 *
 * `@Global` because oversight is asked about from everywhere: the dashboard counts open
 * exceptions, reports summarise them, and the run engine's dead-letter path is one of the things
 * the sweep looks for.
 *
 * Its own module rather than part of Runs, and the separation is the product's, not a filing
 * decision: execution and oversight must not be the same component. A run engine that could also
 * decide its own failures were acceptable would be marking its own homework.
 */
@Global()
@Module({
  controllers: [ExecutorController],
  providers: [ExecutorService],
  exports: [ExecutorService],
})
export class ExecutorModule {}
