'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const WorkforceCanvas = dynamic(() => import('./WorkforceCanvas'), { ssr: false });

/** A contained product story. The page itself never traps the visitor's scroll. */
export function WorkforceExperience() {
  const progress = useRef({ value: 0 });
  const [sceneReady, setSceneReady] = useState(false);

  useEffect(() => {
    let frame = 0;
    const startedAt = performance.now();
    const animate = (now: number) => {
      // objective -> agents -> people decide -> reset, every 16 seconds
      progress.current.value = ((now - startedAt) % 16000) / 16000;
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <section
      className="workforce-experience single-story"
      id="how-it-works"
      aria-label="How UBOSS brings objectives, agents and people together"
    >
      <div className="single-story-shell">
        <div className="single-story-copy">
          <p className="story-eyebrow">
            <span />
            UBOSS / WORKFORCE ORCHESTRATION
          </p>
          <h1>
            From objective
            <br />
            to <em>outcome.</em>
          </h1>
          <p className="single-story-body">
            Create the objective. UBOSS assembles the right agents and skills. Your people stay in
            control of the work that moves forward.
          </p>
          <div className="single-story-actions">
            <Link href="/demo" className="experience-button">
              See your workflow <ArrowRight size={16} />
            </Link>
          </div>
          <div className="single-story-legend" aria-label="The animated workflow stages">
            <span>
              <i />
              01 Objective
            </span>
            <span>
              <i />
              02 Agents
            </span>
            <span>
              <i />
              03 People decide
            </span>
          </div>
        </div>
        <div
          className={`single-story-visual ${sceneReady ? 'is-ready' : ''}`}
          aria-label="An animated objective becoming coordinated agents and a reviewed outcome"
        >
          <div className="visual-topline">
            <span>
              <i /> LIVE WORKFLOW VIEW
            </span>
            <span>AUTONOMOUS / GOVERNED</span>
          </div>
          <div className="visual-loader" aria-hidden="true">
            <span />
          </div>
          <WorkforceCanvas
            progress={progress}
            playing
            onReady={() => setSceneReady(true)}
            onFailure={() => setSceneReady(false)}
          />
          <div className="visual-stage-label">
            <span>OBJECTIVE</span>
            <b>→</b>
            <span>AGENTS</span>
            <b>→</b>
            <span>HUMAN REVIEW</span>
          </div>
        </div>
      </div>
    </section>
  );
}
