import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import Handlebars from 'handlebars';

export function generateClaudeMd(workspaceDir, pkgRoot) {
  const templatePath = join(pkgRoot, 'user-data', 'CLAUDE.md.hbs');
  const configPath = join(workspaceDir, 'arc.config.json');
  const outputPath = join(workspaceDir, 'CLAUDE.md');

  const template = readFileSync(templatePath, 'utf-8');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

  const sanitized = sanitizeConfig(config);

  Handlebars.registerHelper('ifFeature', function(feature, options) {
    return sanitized.features[feature] ? options.fn(this) : options.inverse(this);
  });

  const compiled = Handlebars.compile(template);
  const output = compiled(sanitized);

  writeFileSync(outputPath, output, 'utf-8');
  return outputPath;
}

function sanitizeConfig(config) {
  const s = JSON.parse(JSON.stringify(config));

  if (s.user.name) {
    s.user.name = stripMarkdown(s.user.name).slice(0, 100);
  }
  if (s.user.email) {
    s.user.email = stripMarkdown(s.user.email).slice(0, 254);
  }
  if (s.user.timezone) {
    s.user.timezone = stripMarkdown(s.user.timezone).slice(0, 50);
  }
  if (s.assistant?.name) {
    s.assistant.name = stripMarkdown(s.assistant.name).slice(0, 50);
  }

  return s;
}

function stripMarkdown(str) {
  return str
    .replace(/[#*_`~\[\]()>|]/g, '')
    .replace(/\n/g, ' ')
    .trim();
}
