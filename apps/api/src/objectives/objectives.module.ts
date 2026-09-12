import { Global, Module } from '@nestjs/common';

import { AssignmentService } from './assignment.service.js';
import { ObjectiveClosureController } from './objective-closure.controller.js';
import { ObjectiveClosureService } from './objective-closure.service.js';
import { ObjectiveController } from './objective.controller.js';
import { ObjectiveAnalysisService } from './objective-analysis.service.js';
import { ObjectiveService } from './objective.service.js';
import { WorkflowEditorService } from './workflow-editor.service.js';

/**
 * Objective Optimization / Objective Builder — the approved Form 2.
 *
 * `@Global` because the objective is the anchor almost everything later hangs from: review
 * routing, AI decomposition, agent assignment, approvals, the to-do list, performance events and
 * the reward lifecycle all need to ask "what does this objective's live version say". One
 * service answering that means one place where the immutability rule is applied; a module each
 * caller had to remember to import is a module somebody eventually works around.
 *
 * There is no template provider here, and there will not be one: the locked rule is that there is
 * no Objective Template and no Templates Library. A new objective starts as a draft of its own.
 *
 * `ObjectiveClosureService` (Prompt 34) is separate from `ObjectiveService` and in the same
 * module: the authoring service is 1,900 lines about the Form 2 content, the review routing and
 * the versioning, and closure is a different subject with its own two tables. What they share is
 * the version's status column, governed by the one transition table they both read — which is why
 * they belong in one module and not in one file.
 */
@Global()
@Module({
  controllers: [ObjectiveController, ObjectiveClosureController],
  providers: [
    ObjectiveService,
    ObjectiveAnalysisService,
    WorkflowEditorService,
    AssignmentService,
    ObjectiveClosureService,
  ],
  exports: [
    ObjectiveService,
    ObjectiveAnalysisService,
    WorkflowEditorService,
    AssignmentService,
    ObjectiveClosureService,
  ],
})
export class ObjectivesModule {}
