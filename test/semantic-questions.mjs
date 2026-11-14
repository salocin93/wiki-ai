// Questions worded differently from their article, each with the section where the answer sits (my judgment, so the
// scores compare methods, not ground truth). Shared by semantic-eval.mjs and decision-check.mjs.
export const SET = {
  Photosynthesis: [
    ['how is the oxygen we breathe produced from the molecule plants take up through their roots', /Water photolysis|Z scheme|Light-dependent/],
    ['why do some tropical grasses waste less energy than wheat', /Carbon concentrating|C3 : C4/],
    ['who first showed that plants give off a gas when lit', /Experimental history/],
    ['how did the ancestors of plants acquire their green organelles', /Evolution/],
    ['what share of sunlight ends up stored as chemical energy', /Efficiency/],
    ['what makes the process slow down in hot weather', /Factors/],
  ],
  'Black Death': [
    ['what did people believe caused it before microbes were understood', /Causes/],
    ['how many people perished', /Deaths/],
    ['what happened to wages after so many workers disappeared', /Economic/],
    ['which route did it take from Asia into Europe', /Transmission/],
    ['were minorities blamed for it', /Persecutions/],
    ['what did the sick look like', /Signs and symptoms/],
    ['did it ever return later', /Recurrences/],
  ],
  Coffee: [
    ['who found it first, according to the old stories', /Legendary/],
    ['how do you remove the stimulant from the beans', /Decaffeination/],
    ['which bugs damage the plants', /Pests/],
    ['how does buying straight from farmers at guaranteed prices work', /Fair trade|Specialty/],
    ['when did it reach Europe', /History/],
    ['which places do people sit in to drink it together', /Coffeehouses/],
    ['how is the heat treatment done to bring out flavour', /Roast/],
  ],
  'Ada Lovelace': [
    ['who wrote the first algorithm meant for a machine', /First published computer program/],
    ['was her role in the programming disputed', /Controversy/],
    ['how did she die and at what age', /Death/],
    ['what was her father famous for', /Childhood|Biography/],
    ['has she appeared in fiction', /popular culture/],
    ['did she foresee machines composing music', /Insight/],
  ],
  'Great Barrier Reef': [
    ['what starfish eats the coral', /Crown of thorns/],
    ['are warming oceans bleaching it', /Climate change/],
    ['how did the first European ship find it', /Discovery/],
    ['what do visitors do there and what does it earn', /Tourism/],
    ['how do farm fertilisers affect the water near the coast', /Pollution|Eutrophication|Sediment/],
    ['which sea mammals do indigenous people hunt', /Dugong/],
  ],
  Cat: [
    ['why do they purr or meow at us', /Communication/],
    ['how well can they see in the dark', /Vision/],
    ['when did they start living with people', /Domestication/],
    ['what are the long hairs on the face for', /Whiskers/],
    ['how long do they live', /Lifespan/],
    ['how do they land on their feet', /Balance|Ambulation/],
    ['do they threaten birds', /Impact on wildlife/],
  ],
};
export const UNRELATED = ['who won the 2018 World Cup', 'how do I bake sourdough bread', 'what is the capital of Australia'];
