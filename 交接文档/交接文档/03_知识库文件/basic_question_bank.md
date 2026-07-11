# 基础问题库

## 使用原则

- 每轮只问 1 个最关键的问题。
- 优先问 P1 问题。
- 问法要让患者能理解。
- 避免一次性罗列太多医学术语。

## 结构化现病史、既往史问题池

> 下表是病史类追问的唯一来源。访谈阶段记录已问或患者已主动提供的 ID；最终“医生可能会追问你的信息”只从未覆盖 ID 中选择。

| ID | 分类 | 优先级 | 患者可读问法 |
| --- | --- | --- | --- |
| hpi_onset_time | present_illness | P1 | 这次不舒服或异常最早是什么时候发现的？当时是怎么开始的？ |
| hpi_trigger | present_illness | P2 | 发现不舒服前有没有明显诱因，比如劳累、受凉、外伤或饮食变化？ |
| hpi_main_symptoms_course | present_illness | P1 | 主要有哪些不舒服？从开始到现在是加重、减轻，还是反复出现？ |
| hpi_associated_symptoms | present_illness | P1 | 除了主要不舒服，还有没有发热、疼痛、乏力或其他同时出现的情况？ |
| hpi_treatment_course | present_illness | P2 | 为这个问题去过哪些医院或科室，做过什么检查或治疗，用过什么药，效果怎么样？ |
| hpi_general_condition | present_illness | P2 | 最近的饮食、睡眠、大小便和体重有没有明显变化？ |
| pmh_disease_medication | past_history | P1 | 以前得过哪些比较重要或长期的疾病？现在有没有长期用药？ |
| pmh_surgery_trauma | past_history | P2 | 以前做过手术，或受过比较严重的外伤吗？ |
| pmh_allergy | past_history | P1 | 有没有食物或药物过敏？如果有，过敏时会出现什么情况？ |
| pmh_infectious_disease | past_history | P3 | 以前得过肺结核、病毒性肝炎等传染性疾病吗？ |
| pmh_transfusion | past_history | P3 | 以前有过输血经历吗？如果有，大概是什么时候、因为什么？ |
| pmh_vaccination | past_history | P3 | 预防接种情况是否基本完整？最近有没有接种过与当前情况相关的疫苗？ |

## 诊疗经过

| 优先级 | 字段名 | 问法 | 适用场景 |
| --- | --- | --- | --- |
| P1 | reason_for_exam | 这次做检查主要是因为什么？例如体检、疼痛、不舒服、医生建议复查等。 | 所有报告 |
| P1 | symptom_duration | 如果有不舒服，大概持续多久了？ | 所有报告 |
| P1 | first_or_followup | 这是第一次发现这个问题，还是之前就有、这次复查？ | 异常报告 |
| P2 | previous_result | 以前做过同部位检查吗？如果做过，结果和这次相比有没有变化？ | 异常报告 |
| P2 | doctor_visit | 这份报告是否已经给医生看过？医生有没有让你补充检查？ | 异常报告 |

## 一般情况

| 优先级 | 字段名 | 问法 | 适用场景 |
| --- | --- | --- | --- |
| P1 | age_sex | 方便的话，请补充年龄和性别。 | 所有报告 |
| P1 | major_symptoms | 最近有没有和检查部位相关的不舒服？ | 所有报告 |
| P2 | pregnancy_status | 如果是女性，是否处于孕期、备孕或哺乳期？ | 妇科、乳腺、用药相关 |
| P2 | chronic_disease | 是否有长期疾病，例如高血压、糖尿病、甲状腺疾病、肝病、肾病等？ | 所有报告 |
| P3 | medication | 最近是否长期服用药物或保健品？ | 需要背景资料时 |

## 相关病史

| 优先级 | 字段名 | 问法 | 适用场景 |
| --- | --- | --- | --- |
| P1 | related_history | 以前是否有同一部位的疾病、手术或治疗经历？ | 异常报告 |
| P2 | family_history | 家里直系亲属有没有类似疾病或相关肿瘤病史？ | 甲状腺、乳腺、消化、泌尿等 |
| P2 | intervention_history | 之前有没有做过穿刺、手术、放化疗或介入治疗？ | 复查或异常报告 |
| P3 | allergy_history | 是否有药物或造影剂过敏史？ | 需要进一步检查时 |
