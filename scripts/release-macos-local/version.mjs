import { arch } from "node:os";

export function bumpSemver(version, level) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Версия должна быть X.Y.Z, получено ${version}`);
  }
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (level === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === "minor") {
    minor += 1;
    patch = 0;
  } else if (level === "patch") {
    patch += 1;
  } else {
    throw new Error("Уровень: major, minor или patch");
  }
  return `${major}.${minor}.${patch}`;
}

export function replacePackageVersion(source, next) {
  bumpSemver(next, "patch");
  const pattern = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/;
  if (!pattern.test(source)) {
    throw new Error("В package.json нет поля version");
  }
  return source.replace(pattern, `$1${next}$3`);
}

export function macTargetArch(machineArch = arch()) {
  if (machineArch === "arm64" || machineArch === "x64") return machineArch;
  throw new Error(`Сборка macOS не поддерживает архитектуру ${machineArch}`);
}

export function assertReleaseBranch(branchName) {
  if (branchName !== "dev") {
    throw new Error(
      `Локальный выпуск разрешён только из dev, сейчас: ${branchName || "неизвестно"}`,
    );
  }
}
