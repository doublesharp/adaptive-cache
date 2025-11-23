import debug from 'debug'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
}

export class Logger {
  private level: number
  private loggers = {
    info: debug('adaptive-cache:info'),
    warn: debug('adaptive-cache:warn'),
    error: debug('adaptive-cache:error'),
    debug: debug('adaptive-cache:debug'),
  }

  constructor(level: LogLevel = 'info') {
    this.level = levels[level]
  }

  info(formatter: any, ...args: any[]) {
    if (this.level <= levels.info) this.loggers.info(formatter, ...args)
  }

  warn(formatter: any, ...args: any[]) {
    if (this.level <= levels.warn) this.loggers.warn(formatter, ...args)
  }

  error(formatter: any, ...args: any[]) {
    if (this.level <= levels.error) this.loggers.error(formatter, ...args)
  }

  debug(formatter: any, ...args: any[]) {
    if (this.level <= levels.debug) this.loggers.debug(formatter, ...args)
  }
}

export default new Logger()
