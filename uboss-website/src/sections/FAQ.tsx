const QUESTIONS = [
  [
    'What is the difference between an agent and a skill?',
    'An agent is configured to carry out a particular job. A skill is an approved, versioned definition of how a type of work should be done. UBOSS brings skills, permitted connections and objective context together in an agent.',
  ],
  [
    'Where do people stay involved?',
    'People own the objective, do the human work and make the required approval decisions. UBOSS coordinates the workflow and routes exceptions; an animation or an agent does not replace a person’s authority.',
  ],
  [
    'Can we use our own processes and skills?',
    'Company-custom skills are part of the UBOSS model. In your demo, we’ll explore your process, the output it needs and the rules it must follow before defining the implementation scope.',
  ],
  [
    'How is pricing calculated?',
    'We scope your requirements first: teams, workflows, agents, skills and expected AI usage. Your quote defines the included usage and any additional charges. Published flat rates and self-service subscriptions are not currently offered on this website.',
  ],
  [
    'What should we bring to a demo?',
    'Bring one real, repeatable objective, an example of the inputs and the output you need. Include the process owner and, where relevant, someone responsible for governance. Use non-sensitive examples for the initial conversation.',
  ],
  [
    'Can agents take actions without approval?',
    'Actions are bounded by the configured skill, permissions and company policy. Steps that require approval wait for a person. The workflow also records decisions and exceptions so the team can see what happened.',
  ],
] as const;

export function FAQ() {
  return (
    <section className="landing-section faq-section" id="faq">
      <div className="section-shell faq-layout">
        <div className="section-heading">
          <span className="section-kicker">COMMON QUESTIONS</span>
          <h2>
            Before you
            <br />
            <span>get started.</span>
          </h2>
          <p>
            How agents work, where people decide
            <br />
            and what to expect from a demo.
          </p>
        </div>
        <div className="faq-list">
          {QUESTIONS.map(([question, answer], i) => (
            <details key={question}>
              <summary>
                <span className="faq-number">0{i + 1}</span>
                {question}
                <span className="faq-toggle" aria-hidden="true">
                  +
                </span>
              </summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
