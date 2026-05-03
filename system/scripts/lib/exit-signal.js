export class ExitSignal extends Error {
  constructor(code) {
    super(`ExitSignal(${code})`);
    this.name = 'ExitSignal';
    this.code = Number.isInteger(code) ? code : 1;
  }
}
