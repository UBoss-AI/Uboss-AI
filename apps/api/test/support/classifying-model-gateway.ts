import { Injectable } from '@nestjs/common';

import {
  MockModelGateway,
  type ModelRequest,
  type ModelResponse,
} from '../../src/model-gateway/model-gateway.js';

/**
 * A mock gateway that can answer the one question the analysis refuses to continue without.
 *
 * ## Why this has to exist
 *
 * `ObjectiveAnalysisService` asks a model which part of each step needs a person and **fails the
 * run** if the answer is not a usable classification. That is the client's decision, and the right
 * one: the alternatives were to fall back on the grid column — quietly reinstating the behaviour
 * the change replaced, under a screen claiming the AI had decided — or to call everything human
 * and hand a company a 25-step objective their team now owns because a provider was down.
 *
 * `MockModelGateway` does not answer it, deliberately. A deployment with no provider configured
 * must not produce workflows whose human/AI split nothing decided; that is the fabrication the
 * client's rules forbid. So the mock stays silent and every analysis under it fails — which is
 * correct in production and useless in a test fixture, because seven suites build a workflow draft
 * before they can test anything at all.
 *
 * This is the seam for those fixtures. It lives in `test/` and is wired in by name, so it cannot
 * reach a running system.
 *
 * ## The default: the shape those fixtures were always written around
 *
 * Every one of them builds the same `mixedSteps` — "a human step, a machine step and an approval
 * gate" — with the machine step at **position 2**. That shape came from the grid's `whoEngine`
 * column until the analysis started deciding, and the suites were written against it: they assert
 * node shapes, owners, gates, Skills and to-do lists, not the classifier.
 *
 * So the default reproduces it, which keeps those tests testing what they were written to test.
 * It is stated once, here, rather than copied into seven `beforeEach` blocks where it would read
 * as a fact about each suite instead of a convention shared by all of them.
 *
 * A suite that needs a different split says so with `classifyBy`. The gateway is given the step
 * text and the position and nothing else — it cannot see `whoEngine`, and should not: that the
 * column no longer decides is the whole point of the change this exists to let through.
 */
@Injectable()
export class ClassifyingModelGateway extends MockModelGateway {
  /**
   * How this gateway splits each step between an agent and a person.
   *
   * Null uses the shared default described above: position 2 is the agent's, everything else the
   * person's. A suite that needs a different split — or a step that divides between both — sets
   * this, and the override then says in that suite what that suite needs.
   */
  classifyBy:
    | ((
        position: number,
        work: string,
      ) => {
        aiWork: string | null;
        humanWork: string | null;
      })
    | null = null;

  /** Set to make the classification come back as something the service cannot read. */
  classificationAnswer: string | null = null;

  /**
   * What the gateway answers when asked which tool categories each AI step needs.
   *
   * Null leaves the base mock's reply in place, which the parser cannot read — so the analysis
   * falls back to its own guess and every existing fixture keeps the `Read` / `Read, Write` lists
   * it was written against.
   *
   * A suite that needs a particular category sets it, in the answer's own format
   * (`"1: FinancialChange"`, one line per step). That is the only way to get a high-risk category
   * onto a node the way a real run would produce one — through the parser and the fallback, not by
   * writing the draft JSON directly, which would prove the summary works on a shape no analysis
   * can actually emit.
   */
  toolCategoriesAnswer: string | null = null;

  override async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await super.complete(request);

    if (request.purpose === 'objective.analysis.ai-work' && this.toolCategoriesAnswer !== null) {
      return { ...response, output: this.toolCategoriesAnswer };
    }

    if (request.purpose !== 'objective.analysis.human-work') return response;

    return {
      ...response,
      output: this.classificationAnswer ?? this.classify(request.context),
    };
  }

  /** The context arrives as `1. Collect DHF…` lines — one per step, in position order. */
  private classify(context: string): string {
    const steps = context
      .split('\n')
      .map((line) => /^(\d+)\.\s*(.*)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => {
        const position = Number(match[1]);
        const work = match[2] ?? '';
        const split =
          this.classifyBy?.(position, work) ??
          (position === 2 ? { aiWork: work, humanWork: null } : { aiWork: null, humanWork: work });
        return { position, ...split, why: 'stubbed by the test gateway' };
      });

    return JSON.stringify({ steps });
  }
}
