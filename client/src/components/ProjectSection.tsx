/**
 * ProjectSection (FEAT-DASH-011, spec §3.7) — a per-project group.
 *
 * A project header (name → `#/p/<slug>`, default branch, autonomy mode, mission
 * count) above a responsive grid of {@link MissionCard}s. Used two ways: stacked
 * one-per-project on the global view, and as the whole page on `#/p/<slug>`
 * (`standalone`, which promotes the heading and drops the section chrome).
 */
import type { ReactNode } from 'react';

import type { Project } from '../../../shared/types';
import { formatRoute } from '../lib/route';
import { MissionCard } from './MissionCard';

export function ProjectSection({
  project,
  standalone = false,
}: {
  project: Project;
  standalone?: boolean;
}): ReactNode {
  const meta: string[] = [];
  if (project.autonomy !== null) meta.push(`autonomy ${project.autonomy.mode}`);
  meta.push(`${project.missions.length} mission${project.missions.length === 1 ? '' : 's'}`);

  return (
    <section className={`project-section${standalone ? ' project-section--standalone' : ''}`}>
      <header className="project-section__head">
        <a className="project-section__name" href={formatRoute({ name: 'project', project: project.slug })}>
          {project.slug}
        </a>
        {project.defaultBranch !== null && (
          <span className="project-section__branch mono">{project.defaultBranch}</span>
        )}
        <span className="project-section__spacer" />
        <span className="project-section__meta">{meta.join(' · ')}</span>
      </header>

      {project.missions.length === 0 ? (
        <p className="project-section__empty">no missions in this project</p>
      ) : (
        <div className="mission-grid">
          {project.missions.map((mission) => (
            <MissionCard key={mission.slug} project={project.slug} mission={mission} />
          ))}
        </div>
      )}
    </section>
  );
}
