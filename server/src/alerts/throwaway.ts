// Containers Docker named itself (`docker run` without --name, outside
// compose): throwaway helpers, tests and builds. They raise no alerts
// (decision 18): of 34 alerts in two hours on the live instance, 33 were
// "exited with code 1" of such containers. Name one (or run it from a
// compose project) and its alerts come.
//
// The words of Docker's own name generator (moby pkg/namesgenerator,
// Apache-2.0): "<adjective>_<surname>", a digit after it when a name was
// taken.

const LEFT = new Set(
  (
    'admiring adoring affectionate agitated amazing angry awesome beautiful blissful bold boring brave busy ' +
    'charming clever compassionate competent condescending confident cool cranky crazy dazzling determined ' +
    'distracted dreamy eager ecstatic elastic elated elegant eloquent epic exciting fervent festive flamboyant ' +
    'focused friendly frosty funny gallant gifted goofy gracious great happy hardcore heuristic hopeful hungry ' +
    'infallible inspiring intelligent interesting jolly jovial keen kind laughing loving lucid magical modest ' +
    'musing mystifying naughty nervous nice nifty nostalgic objective optimistic peaceful pedantic pensive ' +
    'practical priceless quirky quizzical recursing relaxed reverent romantic sad serene sharp silly sleepy stoic ' +
    'strange stupefied suspicious sweet tender thirsty trusting unruffled upbeat vibrant vigilant vigorous wizardly ' +
    'wonderful xenodochial youthful zealous zen'
  ).split(' '),
);
const RIGHT = new Set(
  (
    'agnesi albattani allen almeida antonelli archimedes ardinghelli aryabhata austin babbage banach banzai bardeen ' +
    'bartik bassi beaver bell benz bhabha bhaskara black blackburn blackwell bohr booth borg bose bouman boyd ' +
    'brahmagupta brattain brown buck burnell cannon carson cartwright carver cerf chandrasekhar chaplygin chatelet ' +
    'chatterjee chaum chebyshev clarke cohen colden cori cray curie curran darwin davinci dewdney dhawan diffie ' +
    'dijkstra dirac driscoll dubinsky easley edison einstein elbakyan elgamal elion ellis engelbart euclid euler ' +
    'faraday feistel fermat fermi feynman franklin gagarin galileo galois ganguly gates gauss germain goldberg ' +
    'goldstine goldwasser golick goodall gould greider grothendieck haibt hamilton haslett hawking heisenberg ' +
    'hellman hermann herschel hertz heyrovsky hodgkin hofstadter hoover hopper hugle hypatia ishizaka jackson jang ' +
    'jemison jennings jepsen johnson joliot jones kalam kapitsa kare keldysh keller kepler khayyam khorana kilby ' +
    'kirch knuth kowalevski lalande lamarr lamport leakey leavitt lederberg lehmann lewin lichterman liskov ' +
    'lovelace lumiere mahavira margulis matsumoto maxwell mayer mccarthy mcclintock mclaren mclean mcnulty meitner ' +
    'mendel mendeleev meninsky merkle mestorf mirzakhani montalcini moore morse moser murdock napier nash neumann ' +
    'newton nightingale nobel noether northcutt noyce panini pare pascal pasteur payne perlman pike poincare ' +
    'poitras proskuriakova ptolemy raman ramanujan rhodes ride ritchie robinson roentgen rosalind rubin saha sammet ' +
    'sanderson satoshi shamir shannon shaw shirley shockley shtern sinoussi snyder solomon spence stonebraker ' +
    'sutherland swanson swartz swirles taussig tesla tharp thompson torvalds tu turing varahamihira vaughan villani ' +
    'visvesvaraya volhard wescoff wilbur wiles williams williamson wilson wing wozniak wright wu yalow yonath ' +
    'zhukovsky'
  ).split(' '),
);

/** Whether Docker made this name up: two of its words, and maybe a digit. */
export function generatedName(name: string): boolean {
  const m = /^([a-z]+)_([a-z]+)\d?$/.exec(name.replace(/^\//, ''));
  return !!m && LEFT.has(m[1]!) && RIGHT.has(m[2]!);
}

/** A throwaway container: no compose project, and a name Docker made up. */
export const throwaway = (name: string, project: string | null | undefined): boolean => !project && generatedName(name);
