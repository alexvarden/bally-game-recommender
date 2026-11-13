Take-Home Assessment: Senior AI Engineer
Thank you for your interest in the Senior AI Engineer role at Bally’s. As a next step, we have a short, practical take-home assessment.

This role is responsible for taking promising AI capabilities developed through R&D and turning them into reliable production systems. This assessment is designed to reflect that work. We are interested in your engineering judgement, how you evaluate AI behaviour, and how you make pragmatic production decisions.

We estimate this task will take approximately 4 hours. Please do not spend more than that. The potential scope is deliberately larger than the available time; deciding what to prioritise, simplify or leave out is part of the assessment.

The Challenge: Take an AI Game Recommender Towards Production

R&D has demonstrated a promising approach for recommending related casino games from game descriptions and metadata.
Product would now like to use this capability on a Bally’s casino site to show players:
    Because you played [Game X], you might like…

Your task is to build a small, locally runnable service that you believe is an appropriate first step towards production.

Bear in mind who sees the output. This is a player-facing surface on a live, regulated, realmoney product, and it sits on a page with a latency budget. What that implies for your design is for you to decide.

We are not asking you to invent a new recommendation model or build a polished user interface.

Part A – The Service

1. Create the Dataset
We are not supplying a catalogue. Generate your own fictional game catalogue programmatically, using an LLM.
How you model a “game” is up to you, and it matters. Real catalogue data is uneven: some records are rich, some are thin, some fields are missing or inconsistent. A catalogue that is uniformly clean will not exercise the rest of the exercise, so make it look like something that came out of a real system.
Around 100 games is plenty. Commit the generated data and the script that produced it.

2. Build the Service
Build a small TypeScript service that accepts a game and returns a ranked set of related games.
The pipeline should use AI in two distinct ways:
An LLM call that enriches the catalogue — filling in, expanding or deriving metadata where the source record is thin or missing. This is the R&D capability we want productionised.
Semantic matching over embeddings to find related games.
How these fit together, where each one runs, and what the API looks like are for you to decide.
Make the service straightforward for us to install, run and test locally, and give us one easy way to see it working — a documented endpoint, a curl example, or a small harness. Presentation is not assessed; we just want to run it without guessing. If you have time and prefer to record a two-minute walkthrough instead, that is welcome but entirely optional.

3. Make It Production-Shaped
Assume live traffic, multiple brands, and a catalogue that changes over time.
Within the timebox, implement the production concerns you believe matter most. Tell us what you chose not to implement, and why. We are as interested in your restraint as in what you built.
We do not expect a complete production platform or an actual cloud deployment.

4. Evaluate It
Include a small, repeatable evaluation, plus focused automated tests for the software behaviour you consider important.
Both AI stages need evaluating, and they do not need evaluating the same way. You should decide what “good” means for each, what reference data you need, how quality is measured, and what you would gate a release on. Show us a few cases where the system gets it wrong, returns something it should not, or should decline to answer at all.
Software tests and AI evaluations answer different questions. Please do not present test coverage as your AI evaluation.

5. Explain the Production Architecture
Include a short Architecture Decision Record as a separate Markdown file, containing a simple architecture diagram and covering:
the architecture and infrastructure option you selected;
credible alternatives you considered, and why you rejected them;
the trade-offs and consequences you accepted;
failure behaviour, and what a player sees when something is unavailable; •	how you would scale it, and what would trigger that; and
what evidence would cause you to revisit the decision.
You may assume AWS is available, but well-reasoned alternatives are acceptable. Do not implement the infrastructure and do not write Terraform — the ADR should show how you think about deploying and operating the system.

Part B – Leverage

Keep this small. Thirty minutes is enough.
R&D produces prototypes faster than they can be productionised, and the team is small. We want to see how you make the next one cheaper, not just this one.
Include one small reusable artifact, plus a few lines on how it would apply to the next prototype. It can be whatever you would genuinely reach for — an agent skill or command, an AGENTS.md / CLAUDE.md that encodes the standards you want applied, a check script, a schema-and-validation harness, a small MCP server, a template repository.
We care that it is genuinely reusable and that you can say why you chose that shape, far more than that it is elaborate.
Please also leave in every agentic artifact you used during the exercise — agent instruction files, skills, hooks, prompts, rules, configuration, automation. We assess the repository as a whole, and how you work with these tools is part of the role.

Technical Guidelines
Application language: TypeScript.
AI / evaluation / data generation: TypeScript or Python.
AI tools: You are encouraged to use AI coding assistants, LLMs and anything else you would normally use at work. We do.
Deployment: The service only needs to run locally. Do not spend the timebox deploying it or writing infrastructure as code.
Secrets: Do not commit API keys, credentials or private information. Keep paid usage minimal — a local model or a small provider-backed path are both fine.
Deliverable
Submit a link to a Git repository containing:
Your complete codebase.
Your generated catalogue and the script that produced it.
Your tests and evaluation materials.
A README.md explaining how to run the service and the evaluation, your approach, assumptions, trade-offs, and what you intentionally left out.
Your ADR as a separate Markdown file.
Your Part B artifact and note.
Any AGENT.md or AGENTS.md files, skills, hooks, prompts, rules, configuration or other agentic artefacts used during the exercise. Please leave these in place.
In your README, please also tell us roughly how you allocated the four hours, which AI tools you used, and one output you changed or rejected. Separate AI chat transcripts are not required.

What We’re Looking For
Problem-Solving & Creativity: Your choices for the game schema are crucial. How did you decide to model a “game”? What did you include, what did you leave out, and what assumptions did you make about how this would really be used?
AI Judgement & Evaluation: Is each AI step in the pipeline there for a reason? How do you know the enrichment and the matching are any good — and how would you know if they stopped being good?
Production Judgement: What did you protect, and what did you consciously leave alone? Which metrics would you want in front of you once this is serving players?
Pragmatism & Focus: How did you use the 4 hours? We’re looking for a working proof-of-concept. Your technical choices are important — did you select methods appropriate for the dataset size and the time-boxed nature of the task?
Technical Implementation: Is the code clean and understandable? Is the use of the LLM effective and logical? Did you think about practicalities like managing an API key (e.g. using environment variables)?
Ways of Working: How did you approach the problem before you started building? The repository, including its agentic artifacts, should show us a thought process.
Communication: Your README.md is as important as your code. It should clearly explain your approach, design decisions, any trade-offs you made, and instructions on how to run your application.

How to Submit
Please reply to this email with the link to your Git repository when you are finished. 
Questions about the brief are welcome before you start. Where you resolve an ambiguity yourself, just record the assumption in your README.
We are excited to see how you approach the challenge. Good luck!
Best regards,
The Bally’s AI Engineering Team
