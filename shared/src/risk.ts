import type { Risk } from './ai.js';

// Burrow's own risk rules for shell commands. They run on every AI
// suggestion and can only raise the model's label, never lower it: a model
// that calls `rm -rf` harmless does not get the last word.

interface Rule {
  re: RegExp;
  risk: Risk;
  reason: string;
}

// The rest of one simple command: up to ;, &, | or the line's end. Options
// may come anywhere in it ("rm -v -rf", "git -C dir reset --hard",
// "docker compose -f x.yaml down -v"): the rules looked right after the
// tool's name only (AUDIT2 AI-06).
const REST = String.raw`[^;&|\n]*`;
// What a pipe hands a script to: a shell or an interpreter, by name or path, after sudo or env
// with their options (sudo -E bash -, | /bin/bash, | env sh, | python3). Not an interpreter
// given its program (-e, -c, -n, -p, -m json.tool): what comes down the pipe is its data (audit 2026-11).
const RUNNER = String.raw`\|\s*(?:(?:sudo|doas|env)(?:\s+-\S+(?:\s+[^-\s|;&]\S*)?|\s+\w+=\S*)*\s+)?(?:\S*\/)?(?:(?:(?:ba|z|da|k|fi)?sh)\b|(?:python[\d.]*|perl|ruby|node|php)\b(?!\s+-[a-zA-Z]*[ecnpmE]))`;
// A disk device: sda, nvme0n1, mmcblk0, xvda, md0, a device-mapper or by-id name.
const DISK = String.raw`/dev/(?:sd|nvme|mmcblk|hd|vd|xvd|md\d|dm-|mapper/|disk/)`;
// The last word of a simple command: up to ;, &, | or the line's end.
const LAST = String.raw`\S*\s*(?:$|[;&|\n])`;
// A file that grants a shell or runs at a login when written to (audit 2026-11).
const SHELL_FILE = String.raw`["']?\S*(?:authorized_keys2?|\.(?:bash_profile|bashrc|bash_login|profile|zshrc|zprofile|zshenv|zlogin|kshrc|cshrc|tcshrc|login)|/etc/(?:profile|bash\.bashrc|environment|rc\.local|ld\.so\.preload))\b`;
const re = (src: string) => new RegExp(src.replace(/REST/g, REST).replace(/RUNNER/g, RUNNER).replace(/DISK/g, DISK).replace(/LAST/g, LAST).replace(/SHELL_FILE/g, SHELL_FILE), 'm');

const RULES: Rule[] = [
  { re: re(String.raw`\brm\bREST\s(-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)\b`), risk: 'high', reason: 'rm with -r or -f deletes without asking' },
  { re: /\brm\b/, risk: 'medium', reason: 'rm deletes files' },
  { re: /\bdd\b.*\bof=/, risk: 'high', reason: 'dd writes raw to a file or disk' },
  { re: re(String.raw`\bmkfs(\.\w+)?\b|\bmke2fs\b|\bmkswap\b|\bwipefs\b|\b[sgc]?fdisk\b|\bgdisk\b|\bparted\b|\bsgdisk\b|\bblkdiscard\b|\bcryptsetup\bREST\s(luksFormat|erase|luksErase|luksKillSlot)\b`), risk: 'high', reason: 'formats or repartitions a disk' },
  { re: re(String.raw`\bchmod\bREST\s(-[a-zA-Z]*R|--recursive)`), risk: 'high', reason: 'chmod -R changes permissions of a whole tree' },
  { re: re(String.raw`\bchown\bREST\s(-[a-zA-Z]*R|--recursive)`), risk: 'high', reason: 'chown -R changes ownership of a whole tree' },
  { re: re(String.raw`>\s*DISK|\btee\bREST\sDISK|\b(cp|mv|install|rsync)\b[^;&|\n]*\sDISKLAST`), risk: 'high', reason: 'writes directly to a disk device' },
  { re: /:\(\)\s*\{.*\};\s*:/, risk: 'high', reason: 'fork bomb' },
  { re: re(String.raw`\b(shutdown|reboot|poweroff|halt)\b|\bsystemctl\bREST\s(reboot|poweroff|halt|suspend|hibernate|hybrid-sleep|suspend-then-hibernate|kexec)\b`), risk: 'high', reason: 'shuts down or restarts the machine' },
  { re: re(String.raw`\bdocker\bREST\s(system|volume|image|container|network|builder)\s+prune\b|\bdocker\bREST\s(rm|rmi|volume\s+rm)\b`), risk: 'high', reason: 'removes Docker data' },
  { re: re(String.raw`\bdocker[-\s]+compose\bREST\sdown\bREST\s(-v|--volumes)\b`), risk: 'high', reason: 'removes Compose volumes' },
  // A forced push by its refspec too (+main), a mirror; work discarded by checkout or restore; a branch deleted unmerged (audit 2026-11).
  { re: re(String.raw`\bgit\bREST\s(reset\bREST\s--hard|clean\bREST\s-[a-zA-Z]*f|push\bREST\s(--force|--force-with-lease|-f|--mirror))\b|\bgit\bREST\spush\bREST\s\+\S|\bgit\bREST\s(checkout|co)\bREST\s(--|\.|-f|--force)(?=\s|$|[;&|])|\bgit\bREST\srestore\b(?![^;&|\n]*--staged)|\bgit\bREST\sbranch\bREST\s-[a-zA-Z]*D\b|\bgit\bREST\sstash\s+(clear|drop)\b`), risk: 'high', reason: 'discards or overwrites git history or work' },
  { re: /\b(iptables|nft|ufw)\b.*(-F|--flush|flush|reset|disable)/, risk: 'high', reason: 'drops firewall rules' },
  { re: /\buserdel\b|\bdeluser\b|\bpasswd\b|\bvisudo\b|\b(usermod|chpasswd|chsh|chage|gpasswd)\b/, risk: 'high', reason: 'changes accounts or passwords' },
  { re: re(String.raw`\b(curl|wget)\b.*RUNNER`), risk: 'high', reason: 'runs a script from the internet' },
  { re: /\btruncate\b|\bshred\b/, risk: 'high', reason: 'destroys file contents' },
  // Classes the rules missed (A3-SRV-12).
  { re: re(String.raw`\bfind\bREST\s(-delete\b|-(exec|execdir|ok|okdir)\s+(sudo\s+)?(\S*/)?(rm|shred|unlink)\b)`), risk: 'high', reason: 'find deletes everything it matches' },
  { re: re(String.raw`\b(zfs|zpool)\bREST\s(destroy|labelclear)\b|\b(lvremove|vgremove|pvremove)\b|\bbtrfs\bREST\s(subvolume|sub|su)\s+(delete|del)\b`), risk: 'high', reason: 'destroys a pool, volume or subvolume' },
  { re: re(String.raw`\bcrontab\bREST\s-[a-zA-Z]*r`), risk: 'high', reason: 'crontab -r removes every scheduled job' },
  { re: re(String.raw`\bip6?tables\bREST\s(-P|--policy)\s+\S+\s+(DROP|REJECT)\b|\bip6?tables\bREST\s(-j|--jump)\s+(DROP|REJECT)\b|\bufw\bREST\s(deny|reject|default\s+deny)\b|\bnft\bREST\spolicy\s+drop\b`), risk: 'high', reason: 'firewall rule can cut off access' },
  { re: re(String.raw`\bip\bREST\slink\bREST\s(down|delete|del)\b|\bip\bREST\s(a|addr|address|r|ro|route)\s+(flush|del|delete)\b|\bifdown\b|\bifconfig\bREST\sdown\b|\bnmcli\bREST\s(down|disconnect|delete)\b`), risk: 'high', reason: 'takes a network interface down' },
  { re: re(String.raw`\bsystemctl\bREST\s(isolate|rescue|emergency)\b|\binit\s+[016]\b|\btelinit\s+[016]\b`), risk: 'high', reason: 'switches the machine to another run state' },
  { re: re(String.raw`\$\(\s*(curl|wget)\b|\`\s*(curl|wget)\b|<\(\s*(curl|wget)\b|\bbase64\s[^;&\n]*(-d|--decode)\b[^;&\n]*RUNNER`), risk: 'high', reason: 'runs a script fetched or decoded on the spot' },
  { re: re(String.raw`\brsync\bREST\s--(del|delete(-[a-z]+)*|remove-source-files)\b`), risk: 'high', reason: 'rsync deletes files at the destination' },
  { re: /\b(DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE\s+TABLE)\b|\bdropdb\b|\bFLUSHALL\b|\bFLUSHDB\b/i, risk: 'high', reason: 'drops database data' },
  { re: re(String.raw`\bkubectl\bREST\sdelete\b|\bhelm\bREST\s(uninstall|delete)\b`), risk: 'high', reason: 'deletes Kubernetes resources' },
  { re: re(String.raw`\b(tee|cp|install|ln)\b[^;&|\n]*\s/etc/[^\s;&|]*\s*(?:$|[;&|])|\btee\bREST\s/etc/|\bsed\bREST\s(-[a-zA-Z]*i|--in-place)\S*REST\s/etc/|>\s*/etc/`), risk: 'high', reason: 'overwrites system configuration in /etc' },
  { re: re(String.raw`\bchmod\bREST\s/(etc|usr|bin|sbin|lib|lib64|boot|var|root|home)?/?(\s|$)`), risk: 'high', reason: 'chmod on a system folder' },
  // Audit 2026-11: setuid or setgid (u+s, 4755), and world-writable in a system folder (777 /etc/shadow).
  { re: re(String.raw`\bchmod\bREST\s(0?[2467][0-7]{3}|[ugoa]*[+=][rwxXt]*s[rwxXt]*)(?=[\s,]|$)`), risk: 'high', reason: 'chmod sets setuid or setgid' },
  { re: re(String.raw`\bchmod\bREST\s([0-7]?[0-7]{2}[2367]|[ug]*[oa][ugoa]*[+=][rwxXst]*w[rwxXst]*)\sREST/(etc|usr|bin|sbin|lib|lib64|boot|root)/`), risk: 'high', reason: 'chmod makes a system file world-writable' },
  // An append to sudoers or cron grants root or runs as root (audit 2026-11).
  { re: re(String.raw`>>\s*["']?/etc/(sudoers|cron|crontab|anacrontab)|>>\s*["']?/var/spool/cron/|\btee\bREST\s/var/spool/cron/`), risk: 'high', reason: 'appends to sudoers or cron' },
  // Read too low before (audit 2026-11-09): Proxmox guests and storage, Podman, a branch deleted by a push,
  // storage rolled back or shrunk, a container with the host's root, the way in (sshd), an instant
  // reboot, rows deleted, and a command whose name the rules cannot read ($'..', globs, a variable).
  { re: re(String.raw`\b(qm|pct)\bREST\s(destroy|purge)\b|\bpvesm\bREST\s(remove|free)\b`), risk: 'high', reason: 'removes Proxmox guests or storage' },
  { re: re(String.raw`\bpodman\bREST\s(system|volume|image|container|network|pod)\s+prune\b|\bpodman\bREST\s(rm|rmi|volume\s+rm)\b`), risk: 'high', reason: 'removes Podman data' },
  { re: re(String.raw`\bgit\bREST\spush\bREST\s(--delete|-d)\b|\bgit\bREST\spush\bREST\s\S+\s+\+?:\S`), risk: 'high', reason: 'git push deletes a branch' },
  { re: re(String.raw`\bzfs\bREST\srollback\b|\blvreduce\b|\bresize2fs\b`), risk: 'high', reason: 'rolls back or shrinks storage' },
  { re: re(String.raw`\b(docker|podman)\bREST\s(run|create)\bREST\s(--privileged\b|(-v|--volume)[=\s]+/:)|\bnsenter\bREST\s(-t|--target)[=\s]*1\b`), risk: 'high', reason: 'reaches into the host as root' },
  { re: re(String.raw`\bsystemctl\bREST\s(stop|disable|mask|kill)\bREST\s(ssh|sshd|openssh-server)(\.service)?\b|\bservice\s+(ssh|sshd)\s+stop\b`), risk: 'high', reason: 'stops SSH, the way in' },
  { re: /\/proc\/sysrq-trigger/, risk: 'high', reason: 'sysrq acts on the machine at once' },
  { re: /\bDELETE\s+FROM\b/i, risk: 'high', reason: 'deletes database rows' },
  { re: /(?:^|[;&|(]\s*)(?:sudo\s+)?(?:\S*\$'|\S*[?*[]\S*\s|\$(?:\w|\{|\())/m, risk: 'high', reason: "the command's name is hidden from the rules" },
  { re: re('RUNNER'), risk: 'medium', reason: 'pipes text into a shell or interpreter' },
  { re: /\b(python[\d.]*|perl|ruby|node|php)\b\s+-[a-zA-Z]*[ce]\b.*\b(rmtree|unlink|rmSync|rmdirSync|remove|rmdir|system|subprocess|exec|spawn)\b/, risk: 'medium', reason: 'an interpreter one-liner that deletes or runs commands' },
  { re: re(String.raw`\bsed\bREST\s(-[a-zA-Z]*i|--in-place)`), risk: 'medium', reason: 'sed -i edits a file in place' },
  { re: re(String.raw`\bservice\s+\S+\s+(stop|restart)\b`), risk: 'medium', reason: 'stops or restarts a service' },
  { re: /\beval\b|\b(ba|z|da)?sh\s+-c\b/, risk: 'medium', reason: 'eval or sh -c runs a command built at run time' },
  // `> file`, but not `2>`, `>>`, `>&2` or `> /dev/null`.
  { re: /(^|[^>&|0-9])>\s*(?!\/dev\/null\b)[^\s&|>]|(^|\s)1>\s*(?!\/dev\/null\b)[^\s&|>]/, risk: 'medium', reason: 'overwrites a file with >' },
  { re: re(String.raw`>>\s*SHELL_FILE|\btee\bREST\sSHELL_FILE`), risk: 'medium', reason: 'appends to a file that grants a shell or runs at a login' },
  { re: re(String.raw`\b(apt(-get)?|dnf|yum|pacman|apk)\bREST\s(remove|purge|autoremove|erase|del)\b`), risk: 'medium', reason: 'removes packages' },
  { re: re(String.raw`\bsystemctl\bREST\s(stop|disable|mask|restart)\b`), risk: 'medium', reason: 'stops or restarts a service' },
  { re: re(String.raw`\bdocker\bREST\s(stop|kill|restart)\b|\bdocker[-\s]+compose\bREST\s(down|stop|restart)\b`), risk: 'medium', reason: 'stops or restarts containers' },
  { re: /\bkill(all)?\b|\bpkill\b/, risk: 'medium', reason: 'kills processes' },
  { re: /\bmv\b/, risk: 'medium', reason: 'moves or renames files (can overwrite)' },
  { re: /\bsudo\b/, risk: 'medium', reason: 'runs as root' },
];

/**
 * The command as the shell reads its words, roughly: a backslash, a quote and $IFS split no
 * word (r\m, r''m, "r"m, rm${IFS}-rf). The rules run on this copy as well as on the command as
 * written, so the risk can only go up (audit 2026-11).
 */
function normalise(command: string): string {
  return command
    .replace(/\\\n/g, ' ')
    .replace(/\$\{IFS\}|\$IFS\b/g, ' ')
    .replace(/\\/g, '')
    .replace(/["']/g, '');
}

const ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export const maxRisk = (a: Risk, b: Risk): Risk => (ORDER[a] >= ORDER[b] ? a : b);

/** Risk of a command by Burrow's rules, with the reasons that matched. */
export function assessCommand(command: string): { risk: Risk; reasons: string[] } {
  let risk: Risk = 'low';
  const reasons: string[] = [];
  const normal = normalise(command);
  for (const rule of RULES) {
    if (!rule.re.test(command) && !rule.re.test(normal)) continue;
    // "rm" (medium) is implied by "rm -rf" (high): keep one reason per tool.
    if (rule.risk === 'medium' && reasons.some((r) => r.startsWith(rule.reason.split(' ')[0]!))) continue;
    risk = maxRisk(risk, rule.risk);
    reasons.push(rule.reason);
  }
  return { risk, reasons };
}
