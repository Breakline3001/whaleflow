// Shared validation for project node overrides and the global configuration whitelist.
export function validateGenerationOptions(input, { modelMax = 200 } = {}) {
  for (const key of ['imageModel', 'audioModel', 'videoModel', 'voice']) {
    const max = key === 'voice' ? 200 : modelMax;
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > max)) throw new Error(`${key} 必须是长度不超过 ${max} 的字符串`);
  }
  const choices = {
    imageSize: ['auto', '256x256', '512x512', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'],
    imageAspectRatio: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    videoSize: ['720x1280', '1280x720', '1024x1792', '1792x1024'],
  };
  for (const [key, values] of Object.entries(choices)) if (input[key] !== undefined && !values.includes(input[key])) throw new Error(`${key} 无效`);
  if (input.batchSize !== undefined && (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 4)) throw new Error('batchSize 必须为 1 到 4 的整数');
  if (input.videoSeconds !== undefined && ![4, 8, 12].includes(input.videoSeconds)) throw new Error('videoSeconds 必须为 4、8 或 12');
  if (input.imageSize && input.imageSize !== 'auto' && input.imageAspectRatio) {
    const [w, h] = input.imageSize.split('x').map(Number);
    const [a, b] = input.imageAspectRatio.split(':').map(Number);
    // DALL-E's 1792x1024 is its supported approximation of 16:9.
    if (Math.abs((w / h) / (a / b) - 1) > 0.04) throw new Error('imageSize 与 imageAspectRatio 不一致');
  }
}

export function imageParameters(config, data) {
  const merged = { ...config, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
  validateGenerationOptions(merged, { modelMax: 2000 });
  const aspectSizes = { '1:1': '1024x1024', '16:9': '1792x1024', '9:16': '1024x1792', '4:3': null, '3:4': null, '3:2': '1536x1024', '2:3': '1024x1536' };
  const size = merged.imageSize && merged.imageSize !== 'auto' ? merged.imageSize : merged.imageAspectRatio ? aspectSizes[merged.imageAspectRatio] : merged.imageSize;
  if (merged.imageAspectRatio && !size) throw new Error('该宽高比没有标准 OpenAI 图像 size；请指定服务支持的 imageSize');
  const n = merged.batchSize ?? 1;
  // Capability checks belong to request construction, not project validation: old
  // saved choices must remain openable so the UI can explain and correct them.
  // An empty node override means inherit, matching executeWorkflow's model choice.
  const model = data.imageModel?.trim() || config.imageModel?.trim() || '';
  const supportedSizes = /^gpt-image-/.test(model)
    ? ['auto', '1024x1024', '1536x1024', '1024x1536']
    : model === 'dall-e-3'
      ? ['1024x1024', '1792x1024', '1024x1792']
      : model === 'dall-e-2'
        ? ['256x256', '512x512', '1024x1024']
        : null;
  if (size !== undefined && supportedSizes && !supportedSizes.includes(size)) {
    const fromRatio = merged.imageAspectRatio ? `（imageAspectRatio ${merged.imageAspectRatio} 的映射结果）` : '';
    throw new Error(`imageModel ${model} 不支持图像尺寸 ${size}${fromRatio}；支持：${supportedSizes.join('、')}。请调整参数后再运行`);
  }
  if (model === 'dall-e-3' && n !== 1) throw new Error('imageModel dall-e-3 的 batchSize 只能为 1；请调整参数后再运行');
  return { n, ...(size ? { size } : {}) };
}
