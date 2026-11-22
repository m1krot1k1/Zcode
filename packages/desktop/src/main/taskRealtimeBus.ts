/*
 * Публичный вход task realtime bus. Реализация разложена по модулям в
 * ./task-realtime-bus/ (регистрация Host, lease, stream mirror, owner-команды,
 * session messages, дедупликация); здесь сохраняется прежний API класса.
 */
export { TaskRealtimeBus } from "./task-realtime-bus/index.js";
